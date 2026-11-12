import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

/**
 * Test-only HTTP proxy in front of the real MinIO, used to inject storage
 * outcomes the real server cannot be asked to produce (Verification Gate 4):
 * a lost Complete response, or an HTTP 200 whose body is an S3 <Error>.
 * Requests are forwarded with the SAME Host header, so SigV4 signatures made
 * for the proxy address stay valid on MinIO.
 */
export type FaultAction =
  /** Forward, let storage complete, then destroy the client connection. */
  | { kind: 'drop-after-forward' }
  /** Forward, then answer 200 with an <Error> body instead of the real one. */
  | { kind: 'error-200-after-forward'; code: string }
  /** Do not forward; answer 200 with an <Error> body. */
  | { kind: 'error-200-no-forward'; code: string };

export interface S3FaultProxy {
  endpoint: string;
  /** Arms one action for the next CompleteMultipartUpload request. */
  failNextComplete(action: FaultAction): void;
  close(): Promise<void>;
}

const isComplete = (req: IncomingMessage): boolean =>
  req.method === 'POST' &&
  (req.url ?? '').includes('uploadId=') &&
  !(req.url ?? '').includes('uploads');

const errorBody = (code: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>injected by s3-fault-proxy</Message></Error>`;

export async function startS3FaultProxy(target: string): Promise<S3FaultProxy> {
  const upstream = new URL(target);
  let armed: FaultAction | null = null;

  const forward = (
    req: IncomingMessage,
    body: Buffer,
    onResponse: (
      status: number,
      headers: IncomingMessage['headers'],
      data: Buffer,
    ) => void,
    onError: (error: Error) => void,
  ) => {
    const out = httpRequest(
      {
        host: upstream.hostname,
        port: upstream.port,
        method: req.method,
        path: req.url,
        headers: req.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          onResponse(res.statusCode ?? 502, res.headers, Buffer.concat(chunks)),
        );
      },
    );
    out.on('error', onError);
    out.end(body);
  };

  const server: Server = createServer(
    (req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const action = isComplete(req) ? armed : null;
        if (action) armed = null;

        const sendError200 = (code: string) => {
          const xml = errorBody(code);
          res.writeHead(200, {
            'content-type': 'application/xml',
            'content-length': Buffer.byteLength(xml),
          });
          res.end(xml);
        };

        if (action?.kind === 'error-200-no-forward') {
          sendError200(action.code);
          return;
        }
        forward(
          req,
          body,
          (status, headers, data) => {
            if (action?.kind === 'drop-after-forward') {
              req.socket.destroy();
              return;
            }
            if (action?.kind === 'error-200-after-forward') {
              sendError200(action.code);
              return;
            }
            res.writeHead(status, headers);
            res.end(data);
          },
          () => req.socket.destroy(),
        );
      });
    },
  );

  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
  const { port } = server.address() as { port: number };
  return {
    endpoint: `http://127.0.0.1:${port}`,
    failNextComplete(action) {
      armed = action;
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

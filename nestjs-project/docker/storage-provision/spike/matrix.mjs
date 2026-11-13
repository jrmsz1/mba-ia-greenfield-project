// SPIKE — allow/deny matrix per storage identity on an ISOLATED pinned MinIO.
// Never points at the Compose stack. Prints no secret.
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomBytes } from 'node:crypto';

const ENDPOINT = 'http://streamtube-spike-minio:9000';
const BUCKET = 'spike-videos';
const MIB = 1024 * 1024;
const env = process.env;

const client = (accessKeyId, secretAccessKey) =>
  new S3Client({
    endpoint: ENDPOINT,
    region: 'us-east-1',
    forcePathStyle: true,
    maxAttempts: 1,
    credentials: { accessKeyId, secretAccessKey },
  });

const root = client(env.ROOT_USER, env.ROOT_PASS);
const ids = {
  api: client(env.API_ACCESS_KEY, env.API_SECRET_KEY),
  worker: client(env.WORKER_ACCESS_KEY, env.WORKER_SECRET_KEY),
  delivery: client(env.DELIVERY_ACCESS_KEY, env.DELIVERY_SECRET_KEY),
};

const results = [];
const outcome = (e) => (e?.name === 'AccessDenied' || e?.Code === 'AccessDenied' || e?.$metadata?.httpStatusCode === 403 ? 'DENY' : `ERROR:${e?.name}`);

async function check(identity, op, expected, fn) {
  let got;
  let detail = '';
  try {
    const r = await fn();
    got = 'ALLOW';
    if (r && typeof r === 'string') detail = r;
  } catch (e) {
    got = outcome(e);
    if (got.startsWith('ERROR')) detail = String(e?.message ?? e).slice(0, 80);
  }
  results.push({ identity, op, expected, got, ok: got === expected, detail });
}

const key = (id, leaf = 'original') => `videos/${id}/${leaf}`;
const body = (n) => randomBytes(n);
const put = async (c, k, b, meta) =>
  await c.send(new PutObjectCommand({ Bucket: BUCKET, Key: k, Body: b, Metadata: meta }));

async function startUpload(c, k) {
  const out = await c.send(
    new CreateMultipartUploadCommand({
      Bucket: BUCKET,
      Key: k,
      Metadata: { 'upload-binding': 'spike-binding' },
    }),
  );
  return out.UploadId;
}

async function fetchStatus(url, init = {}) {
  const res = await fetch(url, init);
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, length: buf.length };
}

async function main() {
  // Fixtures by ROOT (provisioning-level actor), one original + one thumbnail.
  await put(root, key('fixture'), body(256 * 1024));
  await put(root, key('fixture', 'thumbnail.jpg'), body(1024));

  for (const [name, c] of Object.entries(ids)) {
    const e = (api, worker, delivery) => ({ api, worker, delivery })[name];
    const id = `${name}-${randomBytes(3).toString('hex')}`;

    await check(name, 'HeadBucket', e('ALLOW', 'ALLOW', 'DENY'), () =>
      c.send(new HeadBucketCommand({ Bucket: BUCKET })),
    );
    await check(name, 'CreateBucket (other)', 'DENY', () =>
      c.send(new CreateBucketCommand({ Bucket: `other-${id}` })),
    );
    await check(name, 'CreateBucket (configured, already exists)', 'DENY', () =>
      c.send(new CreateBucketCommand({ Bucket: BUCKET })),
    );
    await check(name, 'ListBuckets', 'DENY', () => c.send(new ListBucketsCommand({})));
    await check(name, 'ListObjectsV2 (bucket)', e('ALLOW', 'ALLOW', 'DENY'), () =>
      c.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'videos/' })),
    );

    // Multipart on its own key.
    let uploadId;
    await check(name, 'CreateMultipartUpload (original, +metadata)', e('ALLOW', 'DENY', 'DENY'), async () => {
      uploadId = await startUpload(c, key(id));
    });
    if (!uploadId) uploadId = await startUpload(ids.api, key(id)); // continue the matrix with an API session
    let etag;
    await check(name, 'UploadPart (direct, own key)', e('ALLOW', 'DENY', 'DENY'), async () => {
      etag = (await c.send(new UploadPartCommand({ Bucket: BUCKET, Key: key(id), UploadId: uploadId, PartNumber: 1, Body: body(5 * MIB) }))).ETag;
    });
    await check(name, 'UploadPart via URL presigned by this identity', e('ALLOW', 'DENY', 'DENY'), async () => {
      const url = await getSignedUrl(c, new UploadPartCommand({ Bucket: BUCKET, Key: key(id), UploadId: uploadId, PartNumber: 2 }), { expiresIn: 300 });
      const r = await fetchStatus(url, { method: 'PUT', body: body(1024) });
      if (r.status !== 200) throw Object.assign(new Error(`HTTP ${r.status}`), { $metadata: { httpStatusCode: r.status } });
    });
    await check(name, 'ListParts', e('ALLOW', 'ALLOW', 'DENY'), () =>
      c.send(new ListPartsCommand({ Bucket: BUCKET, Key: key(id), UploadId: uploadId })),
    );
    await check(name, 'ListMultipartUploads (prefix)', e('ALLOW', 'ALLOW', 'DENY'), () =>
      c.send(new ListMultipartUploadsCommand({ Bucket: BUCKET, Prefix: key(id) })),
    );
    if (!etag) {
      etag = (await ids.api.send(new UploadPartCommand({ Bucket: BUCKET, Key: key(id), UploadId: uploadId, PartNumber: 1, Body: body(5 * MIB) }))).ETag;
    }
    await check(name, 'CompleteMultipartUpload', e('ALLOW', 'DENY', 'DENY'), () =>
      c.send(new CompleteMultipartUploadCommand({ Bucket: BUCKET, Key: key(id), UploadId: uploadId, MultipartUpload: { Parts: [{ PartNumber: 1, ETag: etag }] } })),
    );
    const toAbort = await startUpload(ids.api, key(`${id}-abort`));
    await check(name, 'AbortMultipartUpload', e('ALLOW', 'ALLOW', 'DENY'), () =>
      c.send(new AbortMultipartUploadCommand({ Bucket: BUCKET, Key: key(`${id}-abort`), UploadId: toAbort })),
    );

    // Reads.
    await check(name, 'HeadObject (original)', 'ALLOW', () =>
      c.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key('fixture') })),
    );
    await check(name, 'GetObject (original)', 'ALLOW', () =>
      c.send(new GetObjectCommand({ Bucket: BUCKET, Key: key('fixture') })),
    );
    await check(name, 'GetObject (thumbnail)', 'DENY', () =>
      c.send(new GetObjectCommand({ Bucket: BUCKET, Key: key('fixture', 'thumbnail.jpg') })),
    );
    await check(name, 'Presigned GET original + Range 0-1023 → 206', 'ALLOW', async () => {
      const url = await getSignedUrl(c, new GetObjectCommand({ Bucket: BUCKET, Key: key('fixture'), ResponseContentDisposition: 'attachment; filename="x.mp4"' }), { expiresIn: 300 });
      const r = await fetchStatus(url, { headers: { range: 'bytes=0-1023' } });
      if (r.status !== 206) throw Object.assign(new Error(`HTTP ${r.status}`), { $metadata: { httpStatusCode: r.status } });
      const credential = new URL(url).searchParams.get('X-Amz-Credential') ?? '';
      return `206 ${r.headers.get('content-range')} disposition=${r.headers.get('content-disposition')} signer=${credential.split('/')[0]}`;
    });

    // Writes.
    await check(name, 'PutObject (original, plain PUT)', e('ALLOW', 'DENY', 'DENY'), () =>
      put(c, key(`${id}-plain`), body(1024)),
    );
    await check(name, 'PutObject (thumbnail)', e('DENY', 'ALLOW', 'DENY'), () =>
      put(c, key(id, 'thumbnail.jpg'), body(1024)),
    );
    await check(name, 'PutObject (outside videos/)', 'DENY', () => put(c, `other/${id}`, body(16)));
    await put(root, key(`${id}-victim`), body(1024));
    await check(name, 'DeleteObject (original)', e('ALLOW', 'ALLOW', 'DENY'), () =>
      c.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key(`${id}-victim`) })),
    );
  }

  // Cross-identity multipart: a session opened by the API.
  const crossKey = key(`cross-${randomBytes(3).toString('hex')}`);
  const cross = await startUpload(ids.api, crossKey);
  const crossEtag = (await ids.api.send(new UploadPartCommand({ Bucket: BUCKET, Key: crossKey, UploadId: cross, PartNumber: 1, Body: body(5 * MIB) }))).ETag;
  await check('worker', 'cross: ListParts on API session (reconciler)', 'ALLOW', () =>
    ids.worker.send(new ListPartsCommand({ Bucket: BUCKET, Key: crossKey, UploadId: cross })),
  );
  await check('worker', 'cross: UploadPart into API session', 'DENY', () =>
    ids.worker.send(new UploadPartCommand({ Bucket: BUCKET, Key: crossKey, UploadId: cross, PartNumber: 2, Body: body(1024) })),
  );
  await check('worker', 'cross: Complete API session', 'DENY', () =>
    ids.worker.send(new CompleteMultipartUploadCommand({ Bucket: BUCKET, Key: crossKey, UploadId: cross, MultipartUpload: { Parts: [{ PartNumber: 1, ETag: crossEtag }] } })),
  );
  await check('delivery', 'cross: ListParts on API session', 'DENY', () =>
    ids.delivery.send(new ListPartsCommand({ Bucket: BUCKET, Key: crossKey, UploadId: cross })),
  );
  await check('worker', 'cross: Abort API session (reconciler)', 'ALLOW', () =>
    ids.worker.send(new AbortMultipartUploadCommand({ Bucket: BUCKET, Key: crossKey, UploadId: cross })),
  );
  // A part URL signed by the API for one (uploadId, partNumber) cannot be
  // replayed as a plain PutObject of the original (signature binds the query).
  const replayKey = key(`replay-${randomBytes(3).toString('hex')}`);
  const replayUpload = await startUpload(ids.api, replayKey);
  const partUrl = await getSignedUrl(ids.api, new UploadPartCommand({ Bucket: BUCKET, Key: replayKey, UploadId: replayUpload, PartNumber: 1 }), { expiresIn: 300 });
  const stripped = partUrl.replace(/([?&])(partNumber|uploadId)=[^&]*/g, '$1');
  await check('client', 'presigned part URL replayed as plain PUT', 'DENY', async () => {
    const r = await fetchStatus(stripped, { method: 'PUT', body: body(16) });
    if (r.status !== 200) throw Object.assign(new Error(`HTTP ${r.status}`), { $metadata: { httpStatusCode: r.status } });
  });

  const bad = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? 'OK  ' : 'MISS'} ${r.identity.padEnd(9)} ${r.op.padEnd(56)} expected=${r.expected.padEnd(6)} got=${r.got}${r.detail ? `  [${r.detail}]` : ''}`);
  }
  console.log(`SUMMARY total=${results.length} matched=${results.length - bad.length} mismatched=${bad.length}`);
  process.exitCode = bad.length === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error('HARNESS ERROR', e?.name, e?.message);
  process.exitCode = 2;
});

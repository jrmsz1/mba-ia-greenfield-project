/**
 * Storage error classification (phase-03-videos plan, SI-03.4 action 3 and
 * SI-03.10 action 4). Classified by the S3 error code / error name — which the
 * SDK also extracts from an HTTP 200 response with an `<Error>` body — never
 * by the HTTP status alone.
 *
 * - `definitive`: storage answered with a coded rejection; the operation did
 *   not take effect (e.g. `InvalidPart`, `EntityTooSmall`).
 * - `transient`: storage declared a temporary failure and the call is safe to
 *   repeat (`InternalError`, `ServiceUnavailable`, `SlowDown`), or the request
 *   provably never reached storage (connection refused / DNS failure).
 * - `ambiguous`: the outcome is unknown (timeout, connection reset, lost or
 *   unreadable response, 5xx without a code).
 */
export type StorageErrorKind = 'definitive' | 'transient' | 'ambiguous';

export class StorageError extends Error {
  constructor(
    readonly kind: StorageErrorKind,
    readonly code: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = this.constructor.name;
  }
}

/** Storage could not be reached or answered with a temporary/unknown failure. */
export class StorageUnavailableError extends StorageError {}

/** Storage rejected the operation with a definitive, coded error. */
export class StorageRejectedError extends StorageError {}

/** `NoSuchUpload`: the multipart upload id is unknown to storage. */
export class UploadNotFoundError extends StorageRejectedError {
  constructor(options?: { cause?: unknown }) {
    super('definitive', 'NoSuchUpload', 'Multipart upload not found', options);
  }
}

const TRANSIENT_CODES = new Set([
  'InternalError',
  'ServiceUnavailable',
  'SlowDown',
  'RequestTimeout',
  'ServerSideEncryptionConfigurationNotFoundError',
]);

/**
 * Coded rejections that mean "the operation did not take effect", whatever
 * the HTTP status. The SDK re-throws an HTTP 200 with an `<Error>` body as a
 * 503 server fault that keeps the code (verified on the pinned MinIO), so the
 * code — not the status — decides.
 */
const DEFINITIVE_CODES = new Set([
  'InvalidPart',
  'InvalidPartOrder',
  'EntityTooSmall',
  'EntityTooLarge',
  'MalformedXML',
  'InvalidArgument',
  'InvalidRequest',
  'AccessDenied',
  'NoSuchBucket',
  'NoSuchKey',
]);

const NOT_SENT_NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

const AMBIGUOUS_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ECONNABORTED',
]);

interface SdkLikeError {
  name?: string;
  code?: string;
  Code?: string;
  $metadata?: { httpStatusCode?: number };
  $fault?: 'client' | 'server';
  cause?: unknown;
}

function networkCode(error: SdkLikeError): string | undefined {
  if (typeof error.code === 'string') return error.code;
  const cause = error.cause as SdkLikeError | undefined;
  return typeof cause?.code === 'string' ? cause.code : undefined;
}

export function classifyStorageError(error: unknown): StorageError {
  if (error instanceof StorageError) return error;
  const e = (error ?? {}) as SdkLikeError;
  const code = e.Code ?? e.name ?? 'UnknownError';
  const status = e.$metadata?.httpStatusCode;
  const message = error instanceof Error ? error.message : String(error);

  if (code === 'NoSuchUpload') return new UploadNotFoundError({ cause: error });
  if (DEFINITIVE_CODES.has(code)) {
    return new StorageRejectedError('definitive', code, message, {
      cause: error,
    });
  }

  const net = networkCode(e);
  if (net && NOT_SENT_NETWORK_CODES.has(net)) {
    return new StorageUnavailableError('transient', net, message, {
      cause: error,
    });
  }
  if (
    (net && AMBIGUOUS_NETWORK_CODES.has(net)) ||
    code === 'TimeoutError' ||
    code === 'AbortError' ||
    code === 'RequestTimeoutException'
  ) {
    return new StorageUnavailableError('ambiguous', net ?? code, message, {
      cause: error,
    });
  }
  if (TRANSIENT_CODES.has(code)) {
    return new StorageUnavailableError('transient', code, message, {
      cause: error,
    });
  }
  if (status !== undefined && status >= 400 && status < 500) {
    return new StorageRejectedError('definitive', code, message, {
      cause: error,
    });
  }
  if (status === 200 && e.$fault === 'client') {
    // Error parsed out of a 200 body with a client-fault code.
    return new StorageRejectedError('definitive', code, message, {
      cause: error,
    });
  }
  return new StorageUnavailableError('ambiguous', code, message, {
    cause: error,
  });
}

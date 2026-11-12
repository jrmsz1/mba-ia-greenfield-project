import {
  classifyStorageError,
  StorageRejectedError,
  StorageUnavailableError,
  UploadNotFoundError,
} from './storage-errors';

/** Shape the AWS SDK v3 gives a 200-with-<Error> response (pinned MinIO). */
const sdkError = (code: string, httpStatusCode: number) =>
  Object.assign(new Error(code), {
    name: code,
    Code: code,
    $fault: 'server',
    $metadata: { httpStatusCode },
  });

describe('classifyStorageError', () => {
  it('classifies a coded rejection re-thrown by the SDK as 503 as definitive', () => {
    const result = classifyStorageError(sdkError('InvalidPart', 503));

    expect(result).toBeInstanceOf(StorageRejectedError);
    expect(result).toMatchObject({ kind: 'definitive', code: 'InvalidPart' });
  });

  it('keeps InternalError transient even when the SDK reports it as 503', () => {
    const result = classifyStorageError(sdkError('InternalError', 503));

    expect(result).toBeInstanceOf(StorageUnavailableError);
    expect(result.kind).toBe('transient');
  });

  it('maps NoSuchUpload to UploadNotFoundError', () => {
    expect(classifyStorageError(sdkError('NoSuchUpload', 404))).toBeInstanceOf(
      UploadNotFoundError,
    );
  });

  it('treats a connection refused before sending as transient', () => {
    const result = classifyStorageError(
      Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }),
    );

    expect(result).toMatchObject({ kind: 'transient', code: 'ECONNREFUSED' });
  });

  it('treats a connection reset as ambiguous (outcome unknown)', () => {
    const result = classifyStorageError(
      Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
    );

    expect(result).toMatchObject({ kind: 'ambiguous', code: 'ECONNRESET' });
  });

  it('treats a 5xx without a known code as ambiguous', () => {
    expect(classifyStorageError(sdkError('Unknown', 502)).kind).toBe(
      'ambiguous',
    );
  });
});

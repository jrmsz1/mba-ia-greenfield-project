import { confirmUploadsGone } from './multipart-cleanup';
import {
  classifyStorageError,
  StorageRejectedError,
  StorageUnavailableError,
  UploadNotFoundError,
} from './storage-errors';
import type { StorageService } from './storage.service';

type StorageMock = jest.Mocked<
  Pick<
    StorageService,
    'listMultipartUploads' | 'abortMultipartUpload' | 'listParts' | 'headObject'
  >
>;

function makeStorage(): StorageMock {
  return {
    listMultipartUploads: jest.fn().mockResolvedValue([]),
    abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
    listParts: jest.fn().mockRejectedValue(new UploadNotFoundError()),
    headObject: jest.fn().mockResolvedValue(null),
  };
}

const run = (storage: StorageMock, known: string[] = ['u-1']) =>
  confirmUploadsGone(
    storage as unknown as StorageService,
    'videos/v/original',
    known,
    'token',
    { maxAbortAttempts: 3, backoffMs: 0 },
  );

describe('confirmUploadsGone', () => {
  it('should return aborted when every session is gone and no object exists', async () => {
    const storage = makeStorage();
    storage.listMultipartUploads.mockResolvedValue(['u-2']);

    await expect(run(storage)).resolves.toBe('aborted');
    expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
      'videos/v/original',
      'u-1',
    );
    expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
      'videos/v/original',
      'u-2',
    );
  });

  it('should repeat the abort while ListParts still finds the upload', async () => {
    const storage = makeStorage();
    storage.listParts
      .mockResolvedValueOnce([{ partNumber: 1, sizeBytes: 1, etag: '"e"' }])
      .mockRejectedValueOnce(new UploadNotFoundError());

    await expect(run(storage)).resolves.toBe('aborted');
    expect(storage.abortMultipartUpload).toHaveBeenCalledTimes(2);
  });

  it('should return indeterminate when the upload never disappears', async () => {
    const storage = makeStorage();
    storage.listParts.mockResolvedValue([]);

    await expect(run(storage)).resolves.toBe('indeterminate');
    expect(storage.abortMultipartUpload).toHaveBeenCalledTimes(3);
  });

  it('should never trust an empty listing alone: the object check still runs', async () => {
    const storage = makeStorage();
    storage.headObject.mockResolvedValue({
      contentLength: 1,
      etag: '"x"',
      uploadBinding: 'token',
    });

    await expect(run(storage, [])).resolves.toBe('completed');
  });

  it('should return indeterminate for an object with another binding', async () => {
    const storage = makeStorage();
    storage.headObject.mockResolvedValue({
      contentLength: 1,
      etag: '"x"',
      uploadBinding: 'someone-else',
    });

    await expect(run(storage)).resolves.toBe('indeterminate');
  });

  it('should return indeterminate on a storage error', async () => {
    const storage = makeStorage();
    storage.listMultipartUploads.mockRejectedValue(
      new StorageUnavailableError('ambiguous', 'TimeoutError', 'timeout'),
    );

    await expect(run(storage)).resolves.toBe('indeterminate');
  });

  it('should rethrow errors that are not storage errors', async () => {
    const storage = makeStorage();
    storage.headObject.mockRejectedValue(new TypeError('bug'));

    await expect(run(storage)).rejects.toThrow(TypeError);
  });
});

describe('classifyStorageError', () => {
  const sdkError = (name: string, httpStatusCode?: number, code?: string) =>
    Object.assign(new Error(name), {
      name,
      ...(code ? { code } : {}),
      $metadata: { httpStatusCode },
    });

  it('should map NoSuchUpload to UploadNotFoundError', () => {
    expect(classifyStorageError(sdkError('NoSuchUpload', 404))).toBeInstanceOf(
      UploadNotFoundError,
    );
  });

  it.each([
    'InvalidPart',
    'InvalidPartOrder',
    'EntityTooSmall',
    'MalformedXML',
  ])('should classify %s as definitive', (name) => {
    const error = classifyStorageError(sdkError(name, 400));
    expect(error).toBeInstanceOf(StorageRejectedError);
    expect(error.kind).toBe('definitive');
  });

  it.each(['InternalError', 'ServiceUnavailable', 'SlowDown'])(
    'should classify %s as transient even inside an HTTP 200 body',
    (name) => {
      const error = classifyStorageError(sdkError(name, 200));
      expect(error.kind).toBe('transient');
    },
  );

  it('should classify a coded client fault parsed from a 200 body as definitive', () => {
    const error = Object.assign(sdkError('InvalidPart', 200), {
      $fault: 'client',
    });
    expect(classifyStorageError(error).kind).toBe('definitive');
  });

  it.each([
    ['TimeoutError', undefined, undefined],
    ['Error', undefined, 'ECONNRESET'],
    ['UnknownError', 503, undefined],
  ])('should classify %s (%s, %s) as ambiguous', (name, status, code) => {
    expect(classifyStorageError(sdkError(name, status, code)).kind).toBe(
      'ambiguous',
    );
  });

  it('should classify a refused connection as transient (never sent)', () => {
    expect(
      classifyStorageError(sdkError('Error', undefined, 'ECONNREFUSED')).kind,
    ).toBe('transient');
  });
});

import {
  assertUploadAdmitted,
  planParts,
  sanitizeFilename,
} from './upload-admission';
import {
  ActiveUploadLimitExceededException,
  PendingUploadQuotaExceededException,
  UploadStartRateExceededException,
} from './video.exceptions';

const limits = {
  maxActiveUploadsPerOwner: 3,
  maxPendingUploadBytesPerOwner: 1_000,
};
const idle = { activeUploads: 0, pendingBytes: 0, startsLastHour: 0 };

describe('assertUploadAdmitted', () => {
  it('should admit an upload within every limit', () => {
    expect(() => assertUploadAdmitted(idle, 1_000, limits)).not.toThrow();
  });

  it('should reject the 21st start of the hour first', () => {
    expect(() =>
      assertUploadAdmitted({ ...idle, startsLastHour: 20 }, 1, limits),
    ).toThrow(UploadStartRateExceededException);
  });

  it('should reject when the active-upload limit is reached', () => {
    expect(() =>
      assertUploadAdmitted({ ...idle, activeUploads: 3 }, 1, limits),
    ).toThrow(ActiveUploadLimitExceededException);
  });

  it('should reject when the declared size would exceed the pending-bytes quota', () => {
    expect(() =>
      assertUploadAdmitted({ ...idle, pendingBytes: 600 }, 401, limits),
    ).toThrow(PendingUploadQuotaExceededException);
    expect(() =>
      assertUploadAdmitted({ ...idle, pendingBytes: 600 }, 400, limits),
    ).not.toThrow();
  });
});

describe('sanitizeFilename', () => {
  it.each([
    ['../../etc/passwd\u0007.mp4', 'passwd.mp4'],
    ['C:\\Users\\me\\clip.mp4', 'clip.mp4'],
    ['  movie\u0000.mp4  ', 'movie.mp4'],
    ['..', 'video'],
    ['', 'video'],
  ])('should turn %j into %j', (input, expected) => {
    expect(sanitizeFilename(input)).toBe(expected);
  });

  it('should cap the name at 255 characters', () => {
    expect(sanitizeFilename(`${'a'.repeat(300)}.mp4`)).toHaveLength(255);
  });
});

describe('planParts', () => {
  it('should split 10 GiB into 160 parts of 64 MiB', () => {
    expect(planParts(10_737_418_240, 67_108_864)).toEqual({
      partSizeBytes: 67_108_864,
      expectedPartCount: 160,
    });
  });

  it('should round a partial last part up', () => {
    expect(planParts(10, 4).expectedPartCount).toBe(3);
  });
});

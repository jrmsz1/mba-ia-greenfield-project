import { DomainException } from '../common/exceptions/domain.exception';

/**
 * Domain errors of phase 03 (plan §Error Catalog). Thrown by services, mapped
 * to `{ statusCode, error, message }` by the existing DomainExceptionFilter
 * (phase-02-auth/TD-07). `retryAfterSeconds` becomes a `Retry-After` header.
 */
export abstract class VideoDomainException extends DomainException {
  readonly retryAfterSeconds?: number;
}

abstract class RetryableVideoException extends VideoDomainException {
  constructor(
    errorCode: string,
    httpStatus: number,
    message: string,
    readonly retryAfterSeconds: number,
  ) {
    super(errorCode, httpStatus, message);
  }
}

export class VideoNotFoundException extends VideoDomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class VideoNotReadyException extends VideoDomainException {
  constructor() {
    super('VIDEO_NOT_READY', 409, 'Video is not ready');
  }
}

export class StorageUnavailableException extends RetryableVideoException {
  constructor(retryAfterSeconds = 5) {
    super(
      'STORAGE_UNAVAILABLE',
      503,
      'Storage is temporarily unavailable',
      retryAfterSeconds,
    );
  }
}

export class ChannelRequiredException extends VideoDomainException {
  constructor() {
    super('CHANNEL_REQUIRED', 403, 'A channel is required to upload videos');
  }
}

export class UploadSizeExceededException extends VideoDomainException {
  constructor(maxBytes: number) {
    super(
      'UPLOAD_SIZE_EXCEEDED',
      400,
      `size_bytes exceeds the maximum of ${maxBytes} bytes`,
    );
  }
}

export class ActiveUploadLimitExceededException extends VideoDomainException {
  constructor(limit: number) {
    super(
      'ACTIVE_UPLOAD_LIMIT_EXCEEDED',
      429,
      `At most ${limit} uploads can be in progress at the same time`,
    );
  }
}

export class PendingUploadQuotaExceededException extends VideoDomainException {
  constructor(limitBytes: number) {
    super(
      'PENDING_UPLOAD_QUOTA_EXCEEDED',
      429,
      `Pending uploads would exceed the quota of ${limitBytes} bytes`,
    );
  }
}

export class UploadStartRateExceededException extends VideoDomainException {
  constructor(limit: number) {
    super(
      'UPLOAD_START_RATE_EXCEEDED',
      429,
      `At most ${limit} uploads can be started per hour`,
    );
  }
}

export class IdempotencyKeyConflictException extends VideoDomainException {
  constructor() {
    super(
      'IDEMPOTENCY_KEY_CONFLICT',
      409,
      'Idempotency-Key was already used with a different filename or size',
    );
  }
}

export class UploadStartInProgressException extends RetryableVideoException {
  constructor(retryAfterSeconds = 2) {
    super(
      'UPLOAD_START_IN_PROGRESS',
      409,
      'The upload for this request is being created',
      retryAfterSeconds,
    );
  }
}

export class InvalidVideoStateException extends VideoDomainException {
  constructor(status: string) {
    super(
      'INVALID_VIDEO_STATE',
      409,
      `Operation not allowed while the video is ${status}`,
    );
  }
}

export class UploadExpiredException extends VideoDomainException {
  constructor() {
    super('UPLOAD_EXPIRED', 409, 'The upload has expired');
  }
}

export class UploadPartsMismatchException extends VideoDomainException {
  constructor(partNumbers: number[], storageCode?: string) {
    super(
      'UPLOAD_PARTS_MISMATCH',
      409,
      `Parts do not match the stored upload: ${partNumbers.join(', ')}${
        storageCode ? ` (storage: ${storageCode})` : ''
      }`,
    );
  }
}

/** Manifest shape errors answer the standard validation envelope (400). */
export class ManifestInvalidException extends VideoDomainException {
  constructor(expectedPartCount: number) {
    super(
      'VALIDATION_ERROR',
      400,
      `parts must list exactly part numbers 1..${expectedPartCount} in ascending order`,
    );
  }
}

/** Out-of-range part numbers answer the standard validation envelope. */
export class PartNumbersOutOfRangeException extends VideoDomainException {
  constructor(expectedPartCount: number) {
    super(
      'VALIDATION_ERROR',
      400,
      `part_numbers must be between 1 and ${expectedPartCount}`,
    );
  }
}

export class PartUrlLimitExceededException extends VideoDomainException {
  constructor(limit: number) {
    super(
      'PART_URL_LIMIT_EXCEEDED',
      429,
      `At most ${limit} part URLs can be issued for this upload`,
    );
  }
}

export class DeliveryUrlLimitExceededException extends VideoDomainException {
  constructor(limit: number) {
    super(
      'DELIVERY_URL_LIMIT_EXCEEDED',
      429,
      `At most ${limit} playback/download URLs per hour for this video`,
    );
  }
}

export class UploadControlRateExceededException extends VideoDomainException {
  constructor(limit: number) {
    super(
      'UPLOAD_CONTROL_RATE_EXCEEDED',
      429,
      `At most ${limit} status/complete calls per hour for this video`,
    );
  }
}

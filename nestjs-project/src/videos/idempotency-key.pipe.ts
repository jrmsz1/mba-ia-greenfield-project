import {
  BadRequestException,
  Injectable,
  type PipeTransform,
} from '@nestjs/common';

/** 1..128 printable ASCII characters (plan §API Contracts → Validation Rules). */
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,128}$/;

/**
 * Validates the `Idempotency-Key` header; failures surface as the standard
 * 400 VALIDATION_ERROR through the existing ValidationExceptionFilter.
 */
@Injectable()
export class IdempotencyKeyPipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    if (typeof value !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
      throw new BadRequestException([
        'Idempotency-Key header must be 1 to 128 printable ASCII characters',
      ]);
    }
    return value;
  }
}

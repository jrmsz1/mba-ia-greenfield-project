import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsString,
  Matches,
  Min,
  registerDecorator,
  ValidateNested,
  type ValidationOptions,
} from 'class-validator';
import { S3_LIMITS } from '../../config/video.constants';

/** Quoted or unquoted hex MD5 digest, optional `-N` multipart suffix. */
export const ETAG_PATTERN = /^"?[0-9a-fA-F]{32}(-[0-9]+)?"?$/;

export class CompletePartDto {
  @IsInt()
  @Min(1)
  part_number: number;

  @IsString()
  @Matches(ETAG_PATTERN, { message: 'etag must be a hex digest' })
  etag: string;
}

/** Part numbers strictly ascending from 1 (1, 2, …, N). */
export function IsAscendingFromOne(options?: ValidationOptions) {
  return (object: object, propertyName: string): void => {
    registerDecorator({
      name: 'isAscendingFromOne',
      target: object.constructor,
      propertyName,
      options: {
        message: `${propertyName} must list part numbers 1..N in ascending order`,
        ...options,
      },
      validator: {
        validate(value: unknown): boolean {
          return (
            Array.isArray(value) &&
            value.every(
              (part, i) =>
                typeof part === 'object' &&
                part !== null &&
                (part as { part_number?: unknown }).part_number === i + 1,
            )
          );
        },
      },
    });
  };
}

/**
 * Body of POST /videos/:id/upload/complete (plan §API Contracts). The exact
 * length (`expected_part_count`) depends on the video and is checked by the
 * completion service, with the same VALIDATION_ERROR envelope.
 */
export class CompleteUploadDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(S3_LIMITS.MAX_PARTS)
  @ValidateNested({ each: true })
  @Type(() => CompletePartDto)
  @IsAscendingFromOne()
  parts: CompletePartDto[];
}

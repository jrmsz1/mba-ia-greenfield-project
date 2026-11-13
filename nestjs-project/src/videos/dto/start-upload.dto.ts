import {
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/** Body of POST /videos (plan §API Contracts). */
export class StartUploadDto {
  /** Original file name; sanitized server-side and used only for downloads. */
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  filename: string;

  /**
   * Declared size in bytes. The MAX_UPLOAD_BYTES ceiling is a domain check
   * (UPLOAD_SIZE_EXCEEDED), so it follows configuration.
   */
  @IsInt()
  @IsPositive()
  size_bytes: number;

  /** Advisory MIME hint only; the media is judged by ffprobe. */
  @IsOptional()
  @IsString()
  @MaxLength(127)
  content_type?: string;
}

import {
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { VIDEO_TITLE_MAX_LENGTH } from '../video-title';

/** Body of POST /videos (plan §API Contracts). */
export class StartUploadDto {
  /**
   * Optional title, stored trimmed. Without it the draft is named after the
   * file name minus its extension (video-title.ts).
   */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(VIDEO_TITLE_MAX_LENGTH)
  @Matches(/\S/, { message: 'title must not be blank' })
  title?: string;

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

import { ApiProperty } from '@nestjs/swagger';
import {
  VIDEO_PROCESSING_STATUSES,
  VIDEO_PUBLICATIONS,
  type MediaMetadata,
  type VideoProcessingStatus,
  type VideoPublication,
} from '../video.constants';

/** Response of POST /videos (201 created / 200 replay). */
export class StartUploadResponseDto {
  @ApiProperty({ example: 'aZ3kQ9bX0pL', description: 'public_id' })
  id: string;

  @ApiProperty()
  upload_id: string;

  @ApiProperty({ example: 67108864 })
  part_size_bytes: number;

  @ApiProperty({ example: 160 })
  expected_part_count: number;

  @ApiProperty({ format: 'date-time' })
  upload_expires_at: string;

  @ApiProperty({ enum: VIDEO_PROCESSING_STATUSES, example: 'uploading' })
  processing_status: VideoProcessingStatus;

  @ApiProperty({ enum: VIDEO_PUBLICATIONS, example: 'draft' })
  publication: VideoPublication;
}

/** Response of GET /videos/:id (owner-only draft status). */
export class VideoResponseDto {
  @ApiProperty({ example: 'aZ3kQ9bX0pL', description: 'public_id' })
  id: string;

  @ApiProperty({ enum: VIDEO_PUBLICATIONS })
  publication: VideoPublication;

  @ApiProperty({ enum: VIDEO_PROCESSING_STATUSES })
  processing_status: VideoProcessingStatus;

  @ApiProperty({ nullable: true, type: String })
  failure_reason: string | null;

  @ApiProperty()
  original_filename: string;

  @ApiProperty()
  size_bytes: number;

  @ApiProperty({ nullable: true, type: Number })
  duration_seconds: number | null;

  @ApiProperty({ nullable: true, type: Object })
  media_metadata: MediaMetadata | null;

  @ApiProperty()
  has_thumbnail: boolean;

  @ApiProperty({ format: 'date-time' })
  created_at: string;

  @ApiProperty({ format: 'date-time' })
  updated_at: string;
}

/** Response of POST /videos/:id/upload/complete (200 settled / 202 pending). */
export class CompleteUploadResponseDto {
  @ApiProperty({ example: 'aZ3kQ9bX0pL', description: 'public_id' })
  id: string;

  @ApiProperty({ enum: VIDEO_PROCESSING_STATUSES, example: 'uploaded' })
  processing_status: VideoProcessingStatus;
}

/** Response of GET /videos/:id/playback-url and /download-url (TD-11). */
export class DeliveryUrlResponseDto {
  @ApiProperty({
    description:
      'Presigned GET on the public storage endpoint (temporary credential — do not log or store)',
  })
  url: string;

  @ApiProperty({
    format: 'date-time',
    description: 'Request a new URL before this instant to keep playing',
  })
  expires_at: string;
}

import type {
  StartUploadResponseDto,
  VideoResponseDto,
} from './dto/video-response.dto';
import type { Video } from './entities/video.entity';

/**
 * Entity → wire shapes (plan §API Contracts). Internal fields — the UUID,
 * upload_id outside the start response, the binding token, counters — never
 * leave through GET /videos/:id.
 */
export function toStartUploadResponse(video: Video): StartUploadResponseDto {
  return {
    id: video.public_id,
    title: video.title,
    upload_id: video.upload_id ?? '',
    part_size_bytes: video.part_size_bytes,
    expected_part_count: video.expected_part_count,
    upload_expires_at: video.upload_expires_at.toISOString(),
    processing_status: video.processing_status,
    publication: video.publication,
  };
}

export function toVideoResponse(video: Video): VideoResponseDto {
  return {
    id: video.public_id,
    publication: video.publication,
    processing_status: video.processing_status,
    failure_reason: video.failure_reason,
    title: video.title,
    original_filename: video.original_filename,
    size_bytes: video.declared_size_bytes,
    duration_seconds: video.duration_seconds,
    media_metadata: video.media_metadata,
    has_thumbnail: video.thumbnail_generated_at !== null,
    created_at: video.created_at.toISOString(),
    updated_at: video.updated_at.toISOString(),
  };
}

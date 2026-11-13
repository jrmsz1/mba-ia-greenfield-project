import type { Video } from './entities/video.entity';
import {
  toStartUploadResponse,
  toVideoResponse,
} from './video-response.mapper';

const video = {
  id: '6f1c2b3a-0000-4000-8000-000000000001',
  public_id: 'aZ3kQ9bX0pL',
  channel_id: 'channel-uuid',
  publication: 'draft',
  processing_status: 'uploading',
  failure_reason: null,
  idempotency_key: 'key-1',
  original_filename: 'clip.mp4',
  declared_size_bytes: 12_582_912,
  part_size_bytes: 5_242_880,
  expected_part_count: 3,
  upload_id: 'upload-123',
  upload_binding_token: 'secret-binding',
  upload_expires_at: new Date('2026-11-13T00:00:00Z'),
  duration_seconds: null,
  media_metadata: null,
  thumbnail_generated_at: null,
  part_urls_issued: 4,
  created_at: new Date('2026-11-12T00:00:00Z'),
  updated_at: new Date('2026-11-12T00:00:01Z'),
} as unknown as Video;

describe('video-response.mapper', () => {
  it('should map the start response with the public id and the upload plan', () => {
    expect(toStartUploadResponse(video)).toEqual({
      id: 'aZ3kQ9bX0pL',
      upload_id: 'upload-123',
      part_size_bytes: 5_242_880,
      expected_part_count: 3,
      upload_expires_at: '2026-11-13T00:00:00.000Z',
      processing_status: 'uploading',
      publication: 'draft',
    });
  });

  it('should expose no internal field in the status response', () => {
    const body = toVideoResponse(video);

    expect(body.id).toBe('aZ3kQ9bX0pL');
    expect(body).not.toHaveProperty('upload_id');
    expect(body).not.toHaveProperty('upload_binding_token');
    expect(body).not.toHaveProperty('channel_id');
    expect(body).not.toHaveProperty('part_urls_issued');
    expect(JSON.stringify(body)).not.toContain(
      '6f1c2b3a-0000-4000-8000-000000000001',
    );
  });

  it('should derive has_thumbnail from thumbnail_generated_at', () => {
    expect(toVideoResponse(video).has_thumbnail).toBe(false);
    expect(
      toVideoResponse({ ...video, thumbnail_generated_at: new Date() } as Video)
        .has_thumbnail,
    ).toBe(true);
  });
});

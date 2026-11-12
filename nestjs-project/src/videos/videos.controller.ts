import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { PartUrlsDto } from './dto/part-urls.dto';
import { StartUploadDto } from './dto/start-upload.dto';
import {
  PartUrlsResponseDto,
  UploadStatusResponseDto,
} from './dto/upload-status-response.dto';
import {
  CompleteUploadResponseDto,
  DeliveryUrlResponseDto,
  StartUploadResponseDto,
  VideoResponseDto,
} from './dto/video-response.dto';
import { IdempotencyKey } from './decorators/idempotency-key.decorator';
import { IdempotencyKeyPipe } from './idempotency-key.pipe';
import { VideoAccessPolicy } from './video-access.policy';
import { VideoCompletionService } from './video-completion.service';
import { VideoDeliveryService } from './video-delivery.service';
import {
  toStartUploadResponse,
  toVideoResponse,
} from './video-response.mapper';
import { VideoUploadPartsService } from './video-upload-parts.service';
import { VideoUploadService } from './video-upload.service';
import { COMPLETION_RETRY_AFTER_SECONDS } from './video.constants';

const errorEnvelope = { $ref: getSchemaPath(ApiErrorEnvelope) };

/**
 * Phase 03 video endpoints. Authenticated by the global JwtAuthGuard and
 * explicitly outside the authentication throttler (phase-03-videos/TD-13
 * revision ICC-1); abuse is bounded by the PostgreSQL-backed limits instead.
 */
@ApiTags('videos')
@ApiBearerAuth('access-token')
@SkipThrottle()
@Controller('videos')
export class VideosController {
  constructor(
    private readonly uploads: VideoUploadService,
    private readonly parts: VideoUploadPartsService,
    private readonly access: VideoAccessPolicy,
    private readonly completion: VideoCompletionService,
    private readonly delivery: VideoDeliveryService,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      'Creates the private draft and its S3 multipart upload. Replaying the same Idempotency-Key with the same payload returns the same video (200).',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '1..128 printable ASCII characters, unique per channel',
  })
  @ApiResponse({ status: 201, type: StartUploadResponseDto })
  @ApiResponse({
    status: 200,
    description: 'Replay',
    type: StartUploadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'VALIDATION_ERROR or UPLOAD_SIZE_EXCEEDED',
    schema: errorEnvelope,
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 403,
    description: 'CHANNEL_REQUIRED',
    schema: errorEnvelope,
  })
  @ApiResponse({
    status: 409,
    description:
      'IDEMPOTENCY_KEY_CONFLICT or UPLOAD_START_IN_PROGRESS (Retry-After)',
    schema: errorEnvelope,
  })
  @ApiResponse({
    status: 429,
    description:
      'ACTIVE_UPLOAD_LIMIT_EXCEEDED, PENDING_UPLOAD_QUOTA_EXCEEDED or UPLOAD_START_RATE_EXCEEDED',
    schema: errorEnvelope,
  })
  @ApiResponse({
    status: 503,
    description: 'STORAGE_UNAVAILABLE (Retry-After)',
    schema: errorEnvelope,
  })
  async start(
    @CurrentUser() user: JwtPayload,
    @IdempotencyKey(IdempotencyKeyPipe) idempotencyKey: string,
    @Body() dto: StartUploadDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StartUploadResponseDto> {
    const { video, created } = await this.uploads.start(
      user.sub,
      idempotencyKey,
      {
        filename: dto.filename,
        sizeBytes: dto.size_bytes,
        contentType: dto.content_type,
      },
    );
    res.status(created ? 201 : 200);
    return toStartUploadResponse(video);
  }

  @Get(':id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Owner-only status of a draft video' })
  @ApiResponse({ status: 200, type: VideoResponseDto })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: errorEnvelope,
  })
  async findOne(
    @CurrentUser() user: JwtPayload,
    @Param('id') publicId: string,
  ): Promise<VideoResponseDto> {
    const video = await this.access.findOwnedVideoOrThrow(publicId, user.sub);
    return toVideoResponse(video);
  }

  @Post(':id/upload/part-urls')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Issue presigned part URLs',
    description:
      'Presigned UploadPart URLs (public endpoint) for a batch of part numbers; re-requestable until the upload expires, up to 10 × expected_part_count URLs per upload.',
  })
  @ApiResponse({ status: 200, type: PartUrlsResponseDto })
  @ApiResponse({
    status: 400,
    description: 'VALIDATION_ERROR',
    schema: errorEnvelope,
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: errorEnvelope,
  })
  @ApiResponse({
    status: 409,
    description: 'INVALID_VIDEO_STATE or UPLOAD_EXPIRED',
    schema: errorEnvelope,
  })
  @ApiResponse({
    status: 429,
    description: 'PART_URL_LIMIT_EXCEEDED',
    schema: errorEnvelope,
  })
  async issuePartUrls(
    @CurrentUser() user: JwtPayload,
    @Param('id') publicId: string,
    @Body() dto: PartUrlsDto,
  ): Promise<PartUrlsResponseDto> {
    const video = await this.access.findOwnedVideoOrThrow(publicId, user.sub);
    return { parts: await this.parts.issuePartUrls(video, dto.part_numbers) };
  }

  @Get(':id/upload')
  @ApiOperation({
    summary: 'Upload status and resume information',
    description:
      'Lists the parts storage already holds (number, size, ETag) and the missing part numbers. Shares a 120 calls/hour window with complete.',
  })
  @ApiResponse({ status: 200, type: UploadStatusResponseDto })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: errorEnvelope,
  })
  @ApiResponse({
    status: 409,
    description: 'INVALID_VIDEO_STATE',
    schema: errorEnvelope,
  })
  @ApiResponse({
    status: 429,
    description: 'UPLOAD_CONTROL_RATE_EXCEEDED',
    schema: errorEnvelope,
  })
  @ApiResponse({
    status: 503,
    description: 'STORAGE_UNAVAILABLE (Retry-After)',
    schema: errorEnvelope,
  })
  async uploadStatus(
    @CurrentUser() user: JwtPayload,
    @Param('id') publicId: string,
  ): Promise<UploadStatusResponseDto> {
    const video = await this.access.findOwnedVideoOrThrow(publicId, user.sub);
    return await this.parts.getUploadStatus(video);
  }

  @Post(':id/upload/complete')
  @ApiOperation({
    summary: 'Complete the upload',
    description:
      'Verifies the ordered manifest against storage, completes the multipart upload and proves the final object before enqueueing processing. 202 + Retry-After while the outcome is not proven yet. Shares a 120 calls/hour window with the upload status.',
  })
  @ApiResponse({
    status: 200,
    description: 'Past uploading (also a repeated call)',
    type: CompleteUploadResponseDto,
  })
  @ApiResponse({
    status: 202,
    description: 'Outcome not proven yet; retry after Retry-After seconds',
    type: CompleteUploadResponseDto,
    headers: { 'Retry-After': { schema: { type: 'integer', example: 60 } } },
  })
  @ApiResponse({
    status: 400,
    description: 'VALIDATION_ERROR',
    schema: errorEnvelope,
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: errorEnvelope,
  })
  @ApiResponse({
    status: 409,
    description: 'UPLOAD_PARTS_MISMATCH, UPLOAD_EXPIRED or INVALID_VIDEO_STATE',
    schema: errorEnvelope,
  })
  @ApiResponse({
    status: 429,
    description: 'UPLOAD_CONTROL_RATE_EXCEEDED',
    schema: errorEnvelope,
  })
  @ApiResponse({
    status: 503,
    description: 'STORAGE_UNAVAILABLE (Retry-After)',
    schema: errorEnvelope,
  })
  async complete(
    @CurrentUser() user: JwtPayload,
    @Param('id') publicId: string,
    @Body() dto: CompleteUploadDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CompleteUploadResponseDto> {
    const video = await this.access.findOwnedVideoOrThrow(publicId, user.sub);
    // Before any storage call (phase-03-videos/TD-13).
    await this.parts.reserveControlCall(video.id);
    const result = await this.completion.complete(
      video,
      dto.parts.map((p) => ({ partNumber: p.part_number, etag: p.etag })),
    );
    if (result.outcome === 'pending') {
      res.status(202).setHeader('Retry-After', COMPLETION_RETRY_AFTER_SECONDS);
    } else {
      res.status(200);
    }
    return { id: video.public_id, processing_status: result.processingStatus };
  }

  @Get(':id/playback-url')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Presigned streaming URL',
    description:
      'Owner-only, ready videos only. The URL points at the storage, which serves HTTP Range directly; request a new one before expires_at and keep the playback position. Shares a 60 URLs/hour window with download-url.',
  })
  @ApiResponse({ status: 200, type: DeliveryUrlResponseDto })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: errorEnvelope,
  })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_NOT_READY',
    schema: errorEnvelope,
  })
  @ApiResponse({
    status: 429,
    description: 'DELIVERY_URL_LIMIT_EXCEEDED',
    schema: errorEnvelope,
  })
  async playbackUrl(
    @CurrentUser() user: JwtPayload,
    @Param('id') publicId: string,
  ): Promise<DeliveryUrlResponseDto> {
    const video = await this.access.findOwnedVideoOrThrow(publicId, user.sub);
    return await this.delivery.playbackUrl(video);
  }

  @Get(':id/download-url')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Presigned download URL',
    description:
      'Owner-only, ready videos only. The storage answers with Content-Disposition: attachment and the sanitized original filename (RFC 6266). Shares a 60 URLs/hour window with playback-url.',
  })
  @ApiResponse({ status: 200, type: DeliveryUrlResponseDto })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: errorEnvelope,
  })
  @ApiResponse({
    status: 409,
    description: 'VIDEO_NOT_READY',
    schema: errorEnvelope,
  })
  @ApiResponse({
    status: 429,
    description: 'DELIVERY_URL_LIMIT_EXCEEDED',
    schema: errorEnvelope,
  })
  async downloadUrl(
    @CurrentUser() user: JwtPayload,
    @Param('id') publicId: string,
  ): Promise<DeliveryUrlResponseDto> {
    const video = await this.access.findOwnedVideoOrThrow(publicId, user.sub);
    return await this.delivery.downloadUrl(video);
  }

  @Delete(':id/upload')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Cancel an incomplete upload',
    description:
      'Aborts every multipart session of the video and marks it cancelled only after storage confirms the cleanup.',
  })
  @ApiResponse({
    status: 204,
    description: 'Cancelled (also when already cancelled)',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 404,
    description: 'VIDEO_NOT_FOUND',
    schema: errorEnvelope,
  })
  @ApiResponse({
    status: 409,
    description: 'INVALID_VIDEO_STATE',
    schema: errorEnvelope,
  })
  @ApiResponse({
    status: 503,
    description: 'STORAGE_UNAVAILABLE (Retry-After)',
    schema: errorEnvelope,
  })
  async abort(
    @CurrentUser() user: JwtPayload,
    @Param('id') publicId: string,
  ): Promise<void> {
    const video = await this.access.findOwnedVideoOrThrow(publicId, user.sub);
    await this.parts.abort(video);
  }
}

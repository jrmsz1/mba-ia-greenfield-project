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
import { PartUrlsDto } from './dto/part-urls.dto';
import { StartUploadDto } from './dto/start-upload.dto';
import {
  PartUrlsResponseDto,
  UploadStatusResponseDto,
} from './dto/upload-status-response.dto';
import {
  StartUploadResponseDto,
  VideoResponseDto,
} from './dto/video-response.dto';
import { IdempotencyKey } from './decorators/idempotency-key.decorator';
import { IdempotencyKeyPipe } from './idempotency-key.pipe';
import { VideoAccessPolicy } from './video-access.policy';
import {
  toStartUploadResponse,
  toVideoResponse,
} from './video-response.mapper';
import { VideoUploadPartsService } from './video-upload-parts.service';
import { VideoUploadService } from './video-upload.service';

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

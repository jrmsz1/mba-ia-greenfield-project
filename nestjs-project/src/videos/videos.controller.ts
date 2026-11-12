import {
  Body,
  Controller,
  Get,
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
import { StartUploadDto } from './dto/start-upload.dto';
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
}

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { Video } from './entities/video.entity';
import { UploadRecoveryService } from './upload-recovery.service';
import { VideoAccessPolicy } from './video-access.policy';
import { VideoCompletionService } from './video-completion.service';
import { VideoUploadPartsService } from './video-upload-parts.service';
import { VideoUploadService } from './video-upload.service';
import { VideosController } from './videos.controller';

/** Video upload, status and delivery (phase 03). The API only publishes jobs. */
@Module({
  imports: [
    TypeOrmModule.forFeature([Video, Channel]),
    StorageModule,
    QueueModule.register({ role: 'api' }),
  ],
  controllers: [VideosController],
  providers: [
    VideoAccessPolicy,
    VideoUploadService,
    VideoUploadPartsService,
    UploadRecoveryService,
    VideoCompletionService,
  ],
})
export class VideosModule {}

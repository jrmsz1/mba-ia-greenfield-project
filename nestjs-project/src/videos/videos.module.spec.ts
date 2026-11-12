import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import databaseConfig from '../config/database.config';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import uploadConfig from '../config/upload.config';
import workerConfig from '../config/worker.config';
import { Video } from './entities/video.entity';
import { VideoAccessPolicy } from './video-access.policy';
import { VideoUploadService } from './video-upload.service';
import { VideosController } from './videos.controller';
import { VideosModule } from './videos.module';

/** Stands in for TypeOrmModule.forRoot: the compile test needs no database. */
@Global()
@Module({
  providers: [{ provide: DataSource, useValue: {} }],
  exports: [DataSource],
})
class NoDatabaseModule {}

describe('VideosModule', () => {
  it('should compile and wire the controller, the policy and the upload service', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [
            databaseConfig,
            queueConfig,
            storageConfig,
            uploadConfig,
            workerConfig,
          ],
        }),
        NoDatabaseModule,
        VideosModule,
      ],
    })
      .overrideProvider(getRepositoryToken(Video))
      .useValue({})
      .overrideProvider(getRepositoryToken(Channel))
      .useValue({})
      .compile();

    expect(moduleRef.get(VideosController)).toBeInstanceOf(VideosController);
    expect(moduleRef.get(VideoAccessPolicy)).toBeInstanceOf(VideoAccessPolicy);
    expect(moduleRef.get(VideoUploadService)).toBeInstanceOf(
      VideoUploadService,
    );
  });
});

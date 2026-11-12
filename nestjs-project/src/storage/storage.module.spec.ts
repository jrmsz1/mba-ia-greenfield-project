import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { BucketBootstrapService } from './bucket-bootstrap.service';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

describe('StorageModule', () => {
  it('should compile and expose StorageService and BucketBootstrapService', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    expect(moduleRef.get(StorageService)).toBeInstanceOf(StorageService);
    expect(moduleRef.get(BucketBootstrapService)).toBeInstanceOf(
      BucketBootstrapService,
    );
    await moduleRef.close();
  });
});

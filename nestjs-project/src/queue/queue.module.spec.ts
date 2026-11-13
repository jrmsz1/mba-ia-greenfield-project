import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import databaseConfig from '../config/database.config';
import queueConfig from '../config/queue.config';
import workerConfig from '../config/worker.config';
import { JobPublisherService } from './job-publisher.service';
import { PGBOSS } from './queue.constants';
import { QueueModule } from './queue.module';

describe('QueueModule', () => {
  it.each(['api', 'worker'] as const)(
    'should compile for the %s role and expose the publisher and PgBoss',
    async (role) => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            isGlobal: true,
            load: [databaseConfig, queueConfig, workerConfig],
          }),
          QueueModule.register({ role }),
        ],
      }).compile();

      expect(moduleRef.get(JobPublisherService)).toBeInstanceOf(
        JobPublisherService,
      );
      expect(moduleRef.get(PGBOSS)).toBeDefined();
    },
  );
});

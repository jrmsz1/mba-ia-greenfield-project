import { type DynamicModule, Module } from '@nestjs/common';
import { JobPublisherService } from './job-publisher.service';
import { pgBossProvider, type QueueModuleOptions } from './pgboss.provider';
import { PGBOSS, QUEUE_MODULE_OPTIONS } from './queue.constants';
import { QueueLifecycleService } from './queue-lifecycle.service';

/**
 * pg-boss for the API (`role: 'api'`, publish only) or the worker
 * (`role: 'worker'`, consume + supervise + schedule) — phase-03-videos/TD-05.
 */
@Module({})
export class QueueModule {
  static register(options: QueueModuleOptions): DynamicModule {
    return {
      module: QueueModule,
      providers: [
        { provide: QUEUE_MODULE_OPTIONS, useValue: options },
        pgBossProvider,
        QueueLifecycleService,
        JobPublisherService,
      ],
      exports: [PGBOSS, JobPublisherService],
    };
  }
}

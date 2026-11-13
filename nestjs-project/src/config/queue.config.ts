import { registerAs } from '@nestjs/config';
import { envString } from './video.constants';

/** pg-boss schemas (phase-03-videos/TD-05, TD-15). */
export default registerAs('queue', () => ({
  schema: envString('PGBOSS_SCHEMA'),
  testSchema: envString('PGBOSS_TEST_SCHEMA'),
}));

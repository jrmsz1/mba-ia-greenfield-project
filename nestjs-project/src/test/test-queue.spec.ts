import {
  applyTestQueueEnv,
  assertTestQueueSchema,
  testQueueSchema,
  TestQueueGuardError,
} from './test-queue';

describe('test queue guard', () => {
  it.each(['pgboss', 'queue_jobs', 'pgboss_test_', 'PgBoss_test', ''])(
    'should refuse the non-test schema "%s"',
    (schema) => {
      expect(() => assertTestQueueSchema(schema)).toThrow(TestQueueGuardError);
    },
  );

  it('should accept a schema ending with _test', () => {
    expect(() => assertTestQueueSchema('pgboss_test')).not.toThrow();
  });

  it('should point PGBOSS_SCHEMA at PGBOSS_TEST_SCHEMA', () => {
    const env: NodeJS.ProcessEnv = {
      PGBOSS_SCHEMA: 'pgboss',
      PGBOSS_TEST_SCHEMA: 'queue_test',
    };

    applyTestQueueEnv(env);

    expect(env.PGBOSS_SCHEMA).toBe('queue_test');
  });

  it('should refuse an invalid PGBOSS_TEST_SCHEMA before rewriting anything', () => {
    const env: NodeJS.ProcessEnv = {
      PGBOSS_SCHEMA: 'pgboss',
      PGBOSS_TEST_SCHEMA: 'pgboss',
    };

    expect(() => applyTestQueueEnv(env)).toThrow(TestQueueGuardError);
    expect(env.PGBOSS_SCHEMA).toBe('pgboss');
  });

  it('should default to pgboss_test', () => {
    expect(testQueueSchema({})).toBe('pgboss_test');
  });
});

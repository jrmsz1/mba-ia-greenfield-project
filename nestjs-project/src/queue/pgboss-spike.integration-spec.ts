/**
 * SI-03.1 — Spike: pg-boss × TypeORM (Verification Gate 1).
 *
 * Proves, against the real test PostgreSQL and an isolated pg-boss schema,
 * the eight conditions of phase-03-videos/TD-05:
 *   (1) version compatibility, (2) same-transaction enqueue, (3) rollback
 *   publishes nothing, (4) commit keeps state + job, (5) deterministic schema
 *   initialization, (6) isolated reset, (7) dedupe / retry with backoff /
 *   recovery of interrupted jobs, (8) no transaction open during processing.
 * No mocks: every assertion reads the real database.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { getConstructionPlans, PgBoss, type JobWithMetadata } from 'pg-boss';
import type { DataSource } from 'typeorm';
import { createTestDataSource } from '../test/create-test-data-source';
import { readTestDatabaseConfig } from '../test/test-database';
import {
  fromTypeOrm,
  TransactionRequiredError,
} from './typeorm-pgboss-db.adapter';

const TEST_SCHEMA_PATTERN = /^[a-z][a-z0-9_]*_test$/;
// Own schema, separate from PGBOSS_TEST_SCHEMA (used by the QueueModule in
// tests), so dropping it in afterAll cannot affect other suites of the run.
const PGBOSS_SCHEMA = 'pgboss_spike_test';
const QUEUE = 'spike.video-process';
const SPIKE_TABLE = 'pgboss_spike_videos';

jest.setTimeout(60_000);

function assertTestSchema(schema: string): void {
  if (!TEST_SCHEMA_PATTERN.test(schema)) {
    throw new Error(
      `Refusing to touch pg-boss schema "${schema}": test schemas must match ${TEST_SCHEMA_PATTERN.source}.`,
    );
  }
}

async function resetPgBossSchema(
  dataSource: DataSource,
  schema: string,
): Promise<void> {
  assertTestSchema(schema);
  await dataSource.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await dataSource.query(getConstructionPlans(schema));
}

function bossConnection(): Record<string, unknown> {
  const config = readTestDatabaseConfig();
  return {
    host: config.host,
    port: config.port,
    user: config.username,
    password: config.password,
    database: config.database,
    schema: PGBOSS_SCHEMA,
  };
}

async function startBoss(): Promise<PgBoss> {
  const boss = new PgBoss({
    ...bossConnection(),
    supervise: false,
    schedule: false,
    migrate: false,
  });
  boss.on('error', (error: unknown) => {
    throw error;
  });
  await boss.start();
  return boss;
}

async function findJob(
  boss: PgBoss,
  id: string,
): Promise<JobWithMetadata<unknown> | null> {
  const [job] = await boss.findJobs(QUEUE, { id });
  return job ?? null;
}

async function countSpikeRows(
  dataSource: DataSource,
  id: string,
): Promise<number> {
  const rows: { count: string }[] = await dataSource.query(
    `SELECT count(*)::text AS count FROM "${SPIKE_TABLE}" WHERE id = $1`,
    [id],
  );
  return Number(rows[0].count);
}

async function waitForLine(child: ChildProcess): Promise<string> {
  return await new Promise((resolve, reject) => {
    let buffer = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf('\n');
      if (newline >= 0) resolve(buffer.slice(0, newline));
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('exit', (code) =>
      reject(new Error(`crash worker exited early (${code}): ${stderr}`)),
    );
  });
}

describe('pg-boss × TypeORM spike (Verification Gate 1)', () => {
  let dataSource: DataSource;
  let boss: PgBoss;

  beforeAll(async () => {
    dataSource = createTestDataSource([], { synchronize: false });
    await dataSource.initialize();
    await dataSource.query(
      `CREATE TABLE IF NOT EXISTS "${SPIKE_TABLE}" (id uuid PRIMARY KEY, status text NOT NULL)`,
    );
    await resetPgBossSchema(dataSource, PGBOSS_SCHEMA);
    boss = await startBoss();
    // `exclusive` + singletonKey = at most one queued-or-active job per key;
    // with the default `standard` policy singletonKey alone does not dedupe.
    await boss.createQueue(QUEUE, { policy: 'exclusive' });
  });

  afterAll(async () => {
    await boss?.stop({ graceful: false });
    await dataSource?.query(`DROP TABLE IF EXISTS "${SPIKE_TABLE}"`);
    await dataSource?.query(`DROP SCHEMA IF EXISTS "${PGBOSS_SCHEMA}" CASCADE`);
    await dataSource?.destroy();
  });

  beforeEach(async () => {
    await dataSource.query(`DELETE FROM "${SPIKE_TABLE}"`);
    await boss.deleteAllJobs(QUEUE);
  });

  describe('(5)(6) schema initialization and isolation', () => {
    it('produces the same DDL for the same schema on every call', () => {
      expect(getConstructionPlans(PGBOSS_SCHEMA)).toBe(
        getConstructionPlans(PGBOSS_SCHEMA),
      );
    });

    it('starts pg-boss with migrate: false on a schema created only from getConstructionPlans()', async () => {
      const tables: { table_name: string }[] = await dataSource.query(
        'SELECT table_name FROM information_schema.tables WHERE table_schema = $1',
        [PGBOSS_SCHEMA],
      );
      expect(tables.length).toBeGreaterThan(0);
      expect(await boss.getQueue(QUEUE)).not.toBeNull();
    });

    it('refuses to reset a schema that is not a test schema', async () => {
      await expect(resetPgBossSchema(dataSource, 'pgboss')).rejects.toThrow(
        /Refusing to touch pg-boss schema "pgboss"/,
      );
      const schemas: unknown[] = await dataSource.query(
        "SELECT 1 FROM information_schema.schemata WHERE schema_name = 'pgboss'",
      );
      expect(schemas).toHaveLength(0);
    });
  });

  describe('(2)(3)(4) transactional enqueue through the TypeORM adapter', () => {
    it('commit keeps both the state change and the job', async () => {
      const videoId = crypto.randomUUID();

      const jobId = await dataSource.transaction(async (manager) => {
        await manager.query(
          `INSERT INTO "${SPIKE_TABLE}" (id, status) VALUES ($1, 'uploaded')`,
          [videoId],
        );
        const id = await boss.send(
          QUEUE,
          { videoId },
          { db: fromTypeOrm(manager), singletonKey: videoId },
        );
        // Not committed yet: a pool connection must not see the job.
        expect(await findJob(boss, id as string)).toBeNull();
        return id;
      });

      expect(jobId).toEqual(expect.any(String));
      expect(await countSpikeRows(dataSource, videoId)).toBe(1);
      const job = await findJob(boss, jobId as string);
      expect(job).toMatchObject({
        id: jobId,
        data: { videoId },
        singletonKey: videoId,
        state: 'created',
      });
    });

    it('rollback discards both the state change and the job', async () => {
      const videoId = crypto.randomUUID();
      let jobId: string | null = null;

      await expect(
        dataSource.transaction(async (manager) => {
          await manager.query(
            `INSERT INTO "${SPIKE_TABLE}" (id, status) VALUES ($1, 'uploaded')`,
            [videoId],
          );
          jobId = await boss.send(
            QUEUE,
            { videoId },
            { db: fromTypeOrm(manager), singletonKey: videoId },
          );
          throw new Error('simulated failure after enqueue');
        }),
      ).rejects.toThrow('simulated failure after enqueue');

      expect(jobId).toEqual(expect.any(String));
      expect(await countSpikeRows(dataSource, videoId)).toBe(0);
      expect(await findJob(boss, jobId as unknown as string)).toBeNull();
      expect(await boss.findJobs(QUEUE)).toHaveLength(0);
    });

    it('refuses to publish outside an active transaction', () => {
      expect(() => fromTypeOrm(dataSource.manager)).toThrow(
        TransactionRequiredError,
      );
    });
  });

  describe('(7) dedupe, retry with backoff and recovery of interrupted jobs', () => {
    it('a second send with the same singletonKey creates no second job', async () => {
      const videoId = crypto.randomUUID();
      const first = await dataSource.transaction(
        async (manager) =>
          await boss.send(
            QUEUE,
            { videoId },
            { db: fromTypeOrm(manager), singletonKey: videoId },
          ),
      );
      const second = await dataSource.transaction(
        async (manager) =>
          await boss.send(
            QUEUE,
            { videoId },
            { db: fromTypeOrm(manager), singletonKey: videoId },
          ),
      );

      expect(first).toEqual(expect.any(String));
      expect(second).toBeNull();
      const jobs = await boss.findJobs(QUEUE, { key: videoId });
      expect(jobs).toHaveLength(1);
    });

    it('a failed job is retried with a growing backoff delay', async () => {
      const videoId = crypto.randomUUID();
      const jobId = (await boss.send(
        QUEUE,
        { videoId },
        {
          singletonKey: videoId,
          retryLimit: 3,
          retryDelay: 2,
          retryBackoff: true,
        },
      )) as string;

      const [claimed] = await boss.fetch(QUEUE);
      expect(claimed.id).toBe(jobId);
      const failedAt = Date.now();
      await boss.fail(QUEUE, jobId, new Error('transient storage error'));

      const job = await findJob(boss, jobId);
      expect(job?.state).toBe('retry');
      // retryCount counts claims: it only moves when the job is fetched again.
      expect(job?.retryCount).toBe(0);
      expect(job?.startAfter.getTime()).toBeGreaterThan(failedAt);
      // Not yet due: the backoff keeps it out of the next fetch.
      expect(await boss.fetch(QUEUE)).toHaveLength(0);
    });

    it('a job claimed by a worker killed with SIGKILL is recovered and delivered again', async () => {
      const videoId = crypto.randomUUID();
      const jobId = (await boss.send(
        QUEUE,
        { videoId },
        {
          singletonKey: videoId,
          retryLimit: 2,
          retryDelay: 0,
          expireInSeconds: 1,
        },
      )) as string;

      const child = spawn(
        process.execPath,
        [join(__dirname, 'spike', 'pgboss-crash-worker.cjs')],
        {
          env: {
            ...process.env,
            SPIKE_PGBOSS_CONFIG: JSON.stringify(bossConnection()),
            SPIKE_QUEUE: QUEUE,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      const line = await waitForLine(child);
      expect(JSON.parse(line)).toEqual({ fetched: jobId });
      expect((await findJob(boss, jobId))?.state).toBe('active');

      const exited = new Promise((resolve) => child.on('exit', resolve));
      child.kill('SIGKILL');
      await exited;

      // The claim survives the crash: the job is still active, owned by nobody.
      expect((await findJob(boss, jobId))?.state).toBe('active');

      await new Promise((resolve) => setTimeout(resolve, 2_000));
      await boss.supervise(QUEUE);

      const recovered = await findJob(boss, jobId);
      expect(recovered?.state).toBe('retry');
      const [redelivered] = await boss.fetch(QUEUE);
      expect(redelivered.id).toBe(jobId);
      expect((await findJob(boss, jobId))?.retryCount).toBe(1);
    });
  });

  describe('(8) no transaction stays open while a job is processed', () => {
    it('the worker handler runs with no open transaction on any connection', async () => {
      const videoId = crypto.randomUUID();
      await boss.send(QUEUE, { videoId }, { singletonKey: videoId });
      let openTransactions = -1;

      await new Promise<void>((resolve, reject) => {
        void boss
          .work(QUEUE, { pollingIntervalSeconds: 0.5 }, async () => {
            const rows: { count: string }[] = await dataSource.query(
              `SELECT count(*)::text AS count FROM pg_stat_activity
                WHERE datname = current_database()
                  AND pid <> pg_backend_pid()
                  AND state LIKE 'idle in transaction%'`,
            );
            openTransactions = Number(rows[0].count);
            resolve();
          })
          .catch(reject);
      });

      await boss.offWork(QUEUE);
      expect(openTransactions).toBe(0);
    });
  });
});

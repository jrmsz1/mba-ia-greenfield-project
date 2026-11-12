import { confirmUploadsGone } from '../storage/multipart-cleanup';
import { withVideoSessionLock } from '../videos/video-session-lock';
import { VideoReconcilerWorker } from './video-reconciler.worker';

jest.mock('../storage/multipart-cleanup', () => ({
  confirmUploadsGone: jest.fn(),
}));
jest.mock('../videos/video-session-lock', () => ({
  withVideoSessionLock: jest.fn(
    async (_ds: unknown, _id: string, work: () => Promise<unknown>) => ({
      acquired: true,
      value: await work(),
    }),
  ),
}));

const confirm = confirmUploadsGone as jest.MockedFunction<
  typeof confirmUploadsGone
>;
const lock = withVideoSessionLock as jest.MockedFunction<
  typeof withVideoSessionLock
>;

type Category = 'expired' | 'orphan' | 'stale' | 'uploaded';

function setup(found: Partial<Record<Category, string[]>>) {
  const writes: string[] = [];
  const dataSource = {
    query: jest.fn((sql: string) => {
      if (
        sql.startsWith('SELECT id FROM "videos"') ||
        sql.includes('SELECT v.id')
      ) {
        const category: Category = sql.includes('"upload_id" IS NOT NULL')
          ? 'expired'
          : sql.includes('"upload_id" IS NULL')
            ? 'orphan'
            : sql.includes("'completing'")
              ? 'stale'
              : 'uploaded';
        return Promise.resolve((found[category] ?? []).map((id) => ({ id })));
      }
      writes.push(sql.trim().split(/\s+/)[0]);
      return Promise.resolve([[{ id: 'x' }], 1]);
    }),
  };
  const recovery = {
    loadWithToken: jest.fn().mockResolvedValue({
      processing_status: 'uploading',
      upload_id: null,
      upload_binding_token: 'token',
    }),
    resolve: jest.fn().mockResolvedValue('uploaded'),
    refuseForeignObject: jest.fn().mockResolvedValue('pending'),
  };
  const publisher = {
    publishVideoProcess: jest.fn().mockResolvedValue('job-1'),
  };
  const storage = {}; // the reconciler never calls storage directly
  const worker = new VideoReconcilerWorker(
    {} as never,
    dataSource as never,
    storage as never,
    recovery as never,
    publisher as never,
    { completingStaleMinutes: 15 } as never,
    { schema: 'pgboss_test' } as never,
  );
  return { worker, dataSource, recovery, publisher, writes };
}

describe('VideoReconcilerWorker', () => {
  beforeEach(() => jest.clearAllMocks());

  it('expires an upload only when confirmUploadsGone proves the cleanup (aborted)', async () => {
    const t = setup({ expired: ['v1'] });
    t.recovery.loadWithToken.mockResolvedValue({
      processing_status: 'uploading',
      upload_id: 'u1',
      upload_binding_token: 'token',
    });
    confirm.mockResolvedValue('aborted');

    const report = await t.worker.runOnce();

    expect(confirm).toHaveBeenCalledWith(
      expect.anything(),
      'videos/v1/original',
      ['u1'],
      'token',
      {},
    );
    expect(report.expired).toBe(1);
    expect(t.writes).toEqual(['UPDATE']);
  });

  it('sends an expired upload whose object was completed through the completion proof, never to expired', async () => {
    const t = setup({ expired: ['v1'] });
    t.recovery.loadWithToken.mockResolvedValue({
      processing_status: 'uploading',
      upload_id: 'u1',
      upload_binding_token: 'token',
    });
    confirm.mockResolvedValue('completed');

    const report = await t.worker.runOnce();

    expect(t.recovery.resolve).toHaveBeenCalledWith('v1');
    expect(report).toMatchObject({ expired: 0, expiryResolvedByProof: 1 });
    expect(t.writes).toEqual([]);
  });

  it.each(['expired', 'orphan'] as const)(
    'changes nothing for an %s row when the cleanup is indeterminate (storage down, foreign object)',
    async (category) => {
      const t = setup({ [category]: ['v1'] });
      confirm.mockResolvedValue('indeterminate');

      const report = await t.worker.runOnce();

      expect(report.indeterminate).toBe(1);
      expect(report.expired + report.reservationsRemoved).toBe(0);
      expect(t.writes).toEqual([]);
    },
  );

  it.each(['expired', 'orphan'] as const)(
    'counts an %s row whose key positively holds a missing/foreign-binding object as an identity contradiction',
    async (category) => {
      const t = setup({ [category]: ['v1'] });
      confirm.mockResolvedValue('indeterminate');
      t.recovery.refuseForeignObject.mockResolvedValue('failed');

      const report = await t.worker.runOnce();

      expect(t.recovery.refuseForeignObject).toHaveBeenCalledWith('v1');
      expect(report).toMatchObject({
        identityContradictions: 1,
        indeterminate: 0,
        expired: 0,
        reservationsRemoved: 0,
      });
      expect(t.writes).toEqual([]);
    },
  );

  it('removes an orphan reservation (no upload_id) only after aborted', async () => {
    const t = setup({ orphan: ['v1'] });
    confirm.mockResolvedValue('aborted');

    const report = await t.worker.runOnce();

    expect(confirm).toHaveBeenCalledWith(
      expect.anything(),
      'videos/v1/original',
      [],
      'token',
      {},
    );
    expect(report.reservationsRemoved).toBe(1);
    expect(t.writes).toEqual(['DELETE']);
  });

  it('skips a video whose session lock is held elsewhere, without touching storage', async () => {
    const t = setup({ expired: ['v1'], orphan: ['v2'], stale: ['v3'] });
    lock.mockResolvedValue({ acquired: false });

    const report = await t.worker.runOnce();

    expect(report.lockedSkipped).toBe(3);
    expect(confirm).not.toHaveBeenCalled();
    expect(t.recovery.resolve).not.toHaveBeenCalled();
    lock.mockImplementation(async (_ds, _id, work) => ({
      acquired: true,
      value: await work(),
    }));
  });

  it('resolves a stale completing claim with evidence, allowing the release', async () => {
    const t = setup({ stale: ['v1'] });

    const report = await t.worker.runOnce();

    expect(t.recovery.resolve).toHaveBeenCalledWith('v1', {
      allowRelease: true,
    });
    expect(report.staleClaimsResolved).toBe(1);
  });

  it('counts an ambiguous stale claim as indeterminate', async () => {
    const t = setup({ stale: ['v1'] });
    t.recovery.resolve.mockResolvedValue('pending');

    expect((await t.worker.runOnce()).indeterminate).toBe(1);
  });

  it('republishes a missing job and does not count a deduplicated one', async () => {
    const t = setup({ uploaded: ['v1', 'v2'] });
    t.publisher.publishVideoProcess
      .mockResolvedValueOnce('job-1')
      .mockResolvedValueOnce(null);

    const report = await t.worker.runOnce();

    expect(t.publisher.publishVideoProcess).toHaveBeenCalledTimes(2);
    expect(report.republished).toBe(1);
  });

  it('refuses an unsafe pg-boss schema name before building the job query', async () => {
    const t = setup({});
    const unsafe = new VideoReconcilerWorker(
      {} as never,
      t.dataSource as never,
      {} as never,
      t.recovery as never,
      t.publisher as never,
      { completingStaleMinutes: 15 } as never,
      { schema: 'pgboss"; DROP TABLE videos; --' } as never,
    );

    await expect(unsafe.runOnce()).rejects.toThrow(/Invalid pg-boss schema/);
  });
});

/**
 * Reproducible check of the worker entrypoint's shutdown (SI-03.15 review):
 * the REAL main.worker.ts is spawned against the test resources (the Jest
 * process already points DB_NAME / PGBOSS_SCHEMA / S3_BUCKET at them, and the
 * child inherits that environment) and receives SIGTERM during boot and after
 * boot. A graceful stop is a normal exit (code 0), never a kill by signal.
 *
 * The container-level PID-1 case (Node ignores SIGTERM without a handler,
 * Docker SIGKILLs after stop_grace_period → exit 137) is covered by
 * `init: true` in compose.yaml; reproduce with:
 *   docker compose up -d worker && docker compose stop -t 40 worker
 *   docker inspect -f '{{.State.ExitCode}}' $(docker compose ps -aq worker)
 */
import { spawn, type ChildProcess } from 'node:child_process';

jest.setTimeout(120_000);

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
  ms: number;
}

function startWorker(): { child: ChildProcess; output: () => string } {
  const child = spawn(
    process.execPath,
    ['-r', 'ts-node/register', 'src/worker/main.worker.ts'],
    {
      env: { ...process.env, TS_NODE_TRANSPILE_ONLY: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout?.on('data', (c: Buffer) => (output += c.toString()));
  child.stderr?.on('data', (c: Buffer) => (output += c.toString()));
  return { child, output: () => output };
}

async function exitOf(child: ChildProcess, startedAt: number): Promise<Exit> {
  return await new Promise((resolve) => {
    child.once('exit', (code, signal) =>
      resolve({ code, signal, ms: Date.now() - startedAt }),
    );
  });
}

async function waitForOutput(
  output: () => string,
  text: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!output().includes(text)) {
    if (Date.now() > deadline) {
      throw new Error(`"${text}" not seen; output:\n${output()}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('worker entrypoint shutdown', () => {
  it('exits cleanly on SIGTERM received while booting, before consuming any job', async () => {
    const { child, output } = startWorker();
    // Signal from the stdout event itself, the moment Nest starts creating
    // the context: polling (even every 100 ms) let a fast boot finish first
    // under full-suite load, which exercised the after-boot path instead.
    let sentAt = 0;
    const onData = (chunk: Buffer): void => {
      if (
        sentAt === 0 &&
        chunk.toString().includes('Starting Nest application')
      ) {
        sentAt = Date.now();
        child.kill('SIGTERM');
      }
    };
    child.stdout?.on('data', onData);
    await waitForOutput(output, 'Starting Nest application', 60_000);
    const exit = await exitOf(child, sentAt);

    expect(exit).toMatchObject({ code: 0, signal: null });
    expect(exit.ms).toBeLessThan(10_000);
    expect(output()).toContain('SIGTERM during boot');
    expect(output()).not.toContain('Video worker started');
  });

  it('stops gracefully on SIGTERM after boot: shutdown hooks stop pg-boss, then the signal is re-raised', async () => {
    const { child, output } = startWorker();
    await waitForOutput(output, 'Video worker started', 90_000);
    const sentAt = Date.now();

    child.kill('SIGTERM');
    const exit = await exitOf(child, sentAt);

    // NestJS enableShutdownHooks runs the hooks, removes its listener and
    // re-raises the signal: ending by SIGTERM AFTER the hook is the graceful
    // path (under tini the container then exits 143 promptly, never 137).
    expect(output()).toContain('pg-boss stopped gracefully (SIGTERM)');
    expect(exit.code === 0 || exit.signal === 'SIGTERM').toBe(true);
    expect(exit.ms).toBeLessThan(10_000);
  });
});

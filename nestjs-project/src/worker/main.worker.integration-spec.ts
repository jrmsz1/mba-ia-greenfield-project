/**
 * Reproducible check of the worker entrypoint's shutdown (SI-03.15 review):
 * the REAL main.worker.ts is spawned against the test resources (the Jest
 * process already points DB_NAME / PGBOSS_SCHEMA / S3_BUCKET at them, and the
 * child inherits that environment) and receives SIGTERM during boot and after
 * boot. A graceful stop is a normal exit (code 0), never a kill by signal.
 *
 * Race-free by construction (both races were reproduced under full-suite
 * load before this design):
 * - the exit is observed by a listener attached AT SPAWN — attaching it later
 *   missed a child that exited within the polling gap, and the test hung;
 * - the boot-time SIGTERM is sent from the output event the moment the
 *   marker appears in the ACCUMULATED output — polling let a fast boot finish
 *   first, and a per-chunk match could miss a marker split across chunks.
 *
 * The container-level PID-1 case (Node ignores SIGTERM without a handler,
 * Docker SIGKILLs after stop_grace_period → exit 137) is covered by
 * `init: true` in compose.yaml; reproduce with:
 *   docker compose up -d worker && docker compose stop -t 40 worker
 *   docker inspect -f '{{.State.ExitCode}}' $(docker compose ps -aq worker)
 */
import { spawn } from 'node:child_process';

jest.setTimeout(120_000);

interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
  at: number;
}

interface Worker {
  output: () => string;
  /** Resolves once with the exit; the listener exists from the spawn on. */
  exited: Promise<Exit>;
  /** Resolves when `text` first appears in the accumulated output. */
  seen: (text: string, timeoutMs: number) => Promise<number>;
  kill: () => void;
}

function startWorker(signalOn?: string): Worker {
  const child = spawn(
    process.execPath,
    ['-r', 'ts-node/register', 'src/worker/main.worker.ts'],
    {
      env: { ...process.env, TS_NODE_TRANSPILE_ONLY: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const exited = new Promise<Exit>((resolve) => {
    child.once('exit', (code, signal) =>
      resolve({ code, signal, at: Date.now() }),
    );
  });
  let output = '';
  const waiters: { text: string; resolve: (t: number) => void }[] = [];
  const onData = (chunk: Buffer): void => {
    output += chunk.toString();
    if (signalOn && output.includes(signalOn) && child.exitCode === null) {
      child.kill('SIGTERM'); // repeated calls are harmless once it exited
      signalOn = undefined;
    }
    for (const w of waiters.splice(0)) {
      if (output.includes(w.text)) w.resolve(Date.now());
      else waiters.push(w);
    }
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);

  const seen = (text: string, timeoutMs: number): Promise<number> =>
    output.includes(text)
      ? Promise.resolve(Date.now())
      : Promise.race([
          new Promise<number>((resolve) => waiters.push({ text, resolve })),
          exited.then(() => {
            throw new Error(`exited before "${text}"; output:\n${output}`);
          }),
          new Promise<number>((_, reject) =>
            setTimeout(
              () => reject(new Error(`"${text}" not seen; output:\n${output}`)),
              timeoutMs,
            ).unref(),
          ),
        ]);

  return {
    output: () => output,
    exited,
    seen,
    kill: () => child.kill('SIGTERM'),
  };
}

describe('worker entrypoint shutdown', () => {
  it('exits cleanly on SIGTERM received while booting, before consuming any job', async () => {
    // SIGTERM goes out from the output event the moment Nest starts
    // creating the context — consumption only starts after the hooks.
    const worker = startWorker('Starting Nest application');

    const exit = await worker.exited;

    expect(exit).toMatchObject({ code: 0, signal: null });
    expect(worker.output()).toContain('SIGTERM during boot');
    expect(worker.output()).not.toContain('Video worker started');
  });

  it('stops gracefully on SIGTERM after boot: shutdown hooks stop pg-boss, then the signal is re-raised', async () => {
    const worker = startWorker();
    await worker.seen('Video worker started', 90_000);
    const sentAt = Date.now();

    worker.kill();
    const exit = await worker.exited;

    // NestJS enableShutdownHooks runs the hooks, removes its listener and
    // re-raises the signal: ending by SIGTERM AFTER the hook is the graceful
    // path (under tini the container then exits 143 promptly, never 137).
    expect(worker.output()).toContain('pg-boss stopped gracefully (SIGTERM)');
    expect(exit.code === 0 || exit.signal === 'SIGTERM').toBe(true);
    expect(exit.at - sentAt).toBeLessThan(10_000);
  });
});

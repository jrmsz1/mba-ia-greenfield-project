// Child process used by pgboss-spike.integration-spec.ts (Verification Gate 1,
// condition 7 — recovery of interrupted jobs). It claims one job and then hangs
// until the parent kills it with SIGKILL, simulating a worker that dies
// mid-job without completing or failing it. Not part of the application.
'use strict';

const { PgBoss } = require('pg-boss');

async function main() {
  const config = JSON.parse(process.env.SPIKE_PGBOSS_CONFIG);
  const boss = new PgBoss({
    ...config,
    supervise: false,
    schedule: false,
    migrate: false,
  });
  boss.on('error', (error) => process.stderr.write(`${String(error)}\n`));
  await boss.start();

  const [job] = await boss.fetch(process.env.SPIKE_QUEUE);
  process.stdout.write(`${JSON.stringify({ fetched: job ? job.id : null })}\n`);

  // Keep the process (and its pool) alive until SIGKILL.
  setInterval(() => undefined, 1000);
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});

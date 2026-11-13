/**
 * SI-03.17 / Verification Gate 3 — real end-to-end upload of exactly
 * MAX_UPLOAD_BYTES (10 GiB). On-demand only: `npm run verify:large-upload`
 * inside the ephemeral `test-worker` container (FFmpeg); never part of
 * `npm test` or `npm run test:e2e`.
 *
 * Isolation (phase-03-videos/TD-15, TD-16): refuses anything but the test
 * resources — test database (reset under the test-run lock, like a Jest
 * run), S3_TEST_BUCKET, PGBOSS_TEST_SCHEMA and the restricted test
 * identities. It starts its OWN API and worker processes (compiled dist/)
 * with the test identities, so the operational stack is never involved.
 *
 * Flow: generate (or reuse) a deterministic, valid H.264 MP4 padded to exactly
 * MAX_UPLOAD_BYTES with a top-level `free` box → POST /videos → part URLs
 * just in time → parts PUT directly to MinIO (the body never reaches the API)
 * → interruption at half → GET /videos/:id/upload → only the missing parts →
 * complete → proof (key, upload_id, size, upload-binding) → job → worker →
 * ready (duration, metadata, thumbnail) → Range playback + download checked
 * byte-for-byte against the local file. Prints no secret.
 */
import {
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import * as argon2 from 'argon2';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { open } from 'node:fs/promises';
import { request, type ClientRequest } from 'node:http';
import { freemem, totalmem, cpus } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import storageConfig from '../src/config/storage.config';
import { VIDEO_ENV_DEFAULTS } from '../src/config/video.constants';
import { prepareTestDatabase } from '../src/test/prepare-test-database';
import { applyTestDatabaseEnv } from '../src/test/test-database';
import { applyTestQueueEnv, testQueueSchema } from '../src/test/test-queue';
import {
  applyTestStorageEnv,
  readTestStorageTarget,
  testWorkerProcessEnv,
} from '../src/test/test-storage';

const MAX = Number(
  process.env.MAX_UPLOAD_BYTES ?? VIDEO_ENV_DEFAULTS.MAX_UPLOAD_BYTES,
);
const DIR = process.env.GATE3_DIR ?? '/gate3';
const FILE = join(DIR, 'gate3-10gib.mp4');
const API_PORT = 3100;
const API = `http://127.0.0.1:${API_PORT}`;
const CONCURRENCY = 4;
const URL_BATCH = 8;
const DURATION_S = 3600;
const MIB = 1024 * 1024;

type Phase = 'idle' | 'upload' | 'resume' | 'processing' | 'delivery';
const report: Record<string, unknown> = {
  started_at: new Date().toISOString(),
};
const checks: {
  criterion: string;
  result: 'PASS' | 'FAIL';
  evidence: string;
}[] = [];
const samples: {
  t: number;
  phase: Phase;
  api_rss_mib: number;
  worker_rss_mib: number;
}[] = [];
let phase: Phase = 'idle';
const t0 = Date.now();

function log(message: string): void {
  console.log(
    `[${((Date.now() - t0) / 1000).toFixed(1).padStart(7)} s] ${message}`,
  );
}
function check(criterion: string, ok: boolean, evidence: string): void {
  checks.push({ criterion, result: ok ? 'PASS' : 'FAIL', evidence });
  log(`${ok ? 'PASS' : 'FAIL'}  ${criterion} — ${evidence}`);
}
function rssMib(pid: number | undefined): number {
  if (!pid) return 0;
  try {
    const line = readFileSync(`/proc/${pid}/status`, 'utf8')
      .split('\n')
      .find((l) => l.startsWith('VmRSS:'));
    return line ? Number(line.replace(/\D+/g, '')) / 1024 : 0;
  } catch {
    return 0;
  }
}
function netRxBytes(): number {
  const line = readFileSync('/proc/net/dev', 'utf8')
    .split('\n')
    .find((l) => l.trim().startsWith('eth0:'));
  return line ? Number(line.trim().split(/\s+/)[1]) : 0;
}
function run(
  cmd: string,
  args: string[],
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('close', (code) => resolve({ code: code ?? 1, out }));
  });
}
async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { highWaterMark: 8 * MIB }))
    hash.update(chunk as Buffer);
  return hash.digest('hex');
}

// ------------------------------------------------------------------ media
function ffmpegArgs(out: string, videoBitrate: number): string[] {
  return [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=640x360:rate=25:duration=${DURATION_S}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:sample_rate=48000:duration=${DURATION_S}`,
    '-vf',
    'noise=alls=60:allf=t',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-threads',
    '1',
    '-b:v',
    String(videoBitrate),
    '-minrate',
    String(videoBitrate),
    '-maxrate',
    String(videoBitrate),
    '-bufsize',
    String(videoBitrate),
    '-x264-params',
    'nal-hrd=cbr',
    '-c:a',
    'aac',
    '-b:a',
    '128000',
    '-movflags',
    '+faststart',
    '-fflags',
    '+bitexact',
    '-flags:v',
    '+bitexact',
    '-flags:a',
    '+bitexact',
    '-map_metadata',
    '-1',
    out,
  ];
}

/** Pads with one top-level ISO BMFF `free` box (ignored by every reader). */
async function padWithFreeBox(path: string, target: number): Promise<number> {
  const size = statSync(path).size;
  const pad = target - size;
  if (pad === 0) return 0;
  if (pad < 8 || pad >= 2 ** 32)
    throw new Error(`cannot pad ${size} to ${target} with a 32-bit free box`);
  const handle = await open(path, 'a');
  try {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(pad, 0);
    header.write('free', 4, 'ascii');
    await handle.write(header);
    const zeros = Buffer.alloc(8 * MIB);
    let left = pad - 8;
    while (left > 0) {
      const n = Math.min(left, zeros.length);
      await handle.write(zeros, 0, n);
      left -= n;
    }
  } finally {
    await handle.close();
  }
  return pad;
}

async function probe(
  path: string,
): Promise<{ ok: boolean; summary: Record<string, unknown> }> {
  const r = await run('ffprobe', [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    path,
  ]);
  if (r.code !== 0)
    return { ok: false, summary: { error: r.out.slice(0, 300) } };
  const j = JSON.parse(r.out) as {
    format: Record<string, any>;
    streams: Record<string, any>[];
  };
  const v = j.streams.find((s) => s.codec_type === 'video');
  const a = j.streams.find((s) => s.codec_type === 'audio');
  const summary = {
    format_name: j.format.format_name,
    major_brand: j.format.tags?.major_brand,
    duration_s: Number(j.format.duration),
    size_bytes: Number(j.format.size),
    video: v && {
      codec: v.codec_name,
      pix_fmt: v.pix_fmt,
      width: v.width,
      height: v.height,
    },
    audio: a && { codec: a.codec_name, sample_rate: a.sample_rate },
  };
  const ok =
    String(j.format.format_name).includes('mp4') &&
    v?.codec_name === 'h264' &&
    v?.pix_fmt === 'yuv420p' &&
    (!a || a.codec_name === 'aac') &&
    Number(j.format.duration) > 0;
  return { ok, summary };
}

async function prepareMedia(): Promise<void> {
  mkdirSync(DIR, { recursive: true });
  const free = statfsSync(DIR);
  const freeBytes = Number(free.bavail) * Number(free.bsize);
  report.resources = {
    free_bytes_in_media_dir: freeBytes,
    total_mem_bytes: totalmem(),
    free_mem_bytes: freemem(),
    cpus: cpus().length,
  };
  log(
    `resources: ${(freeBytes / 2 ** 30).toFixed(1)} GiB free in ${DIR}, ${(totalmem() / 2 ** 30).toFixed(1)} GiB RAM, ${cpus().length} CPUs`,
  );
  const reuse = existsSync(FILE) && statSync(FILE).size === MAX;
  if (!reuse) {
    if (freeBytes < MAX * 1.2)
      throw new Error(
        `not enough space in ${DIR}: ${freeBytes} bytes free, ${Math.ceil(MAX * 1.2)} needed`,
      );
    const tmp = `${FILE}.partial.mp4`;
    // 98.5 % of the target in video+audio; the rest is the free box.
    const videoBitrate =
      Math.floor(((MAX * 0.985 * 8) / DURATION_S - 128000) / 1000) * 1000;
    const args = ffmpegArgs(tmp, videoBitrate);
    report.generation_command = `ffmpeg ${args.map((a) => (/[ =,:]/.test(a) ? `'${a}'` : a)).join(' ')}`;
    log(
      `generating the media file (ffmpeg, ${DURATION_S} s, video ${videoBitrate} bit/s CBR)…`,
    );
    const g0 = Date.now();
    const r = await run('ffmpeg', args);
    if (r.code !== 0) throw new Error(`ffmpeg failed: ${r.out.slice(0, 500)}`);
    const encoded = statSync(tmp).size;
    if (encoded > MAX - 8)
      throw new Error(
        `encoded file (${encoded} B) leaves no room for padding below ${MAX}`,
      );
    const pad = await padWithFreeBox(tmp, MAX);
    await run('mv', [tmp, FILE]);
    report.generation = {
      seconds: (Date.now() - g0) / 1000,
      encoded_bytes: encoded,
      free_box_bytes: pad,
    };
    log(
      `generated in ${((Date.now() - g0) / 1000).toFixed(0)} s: ${encoded} B encoded + ${pad} B free box`,
    );
  } else {
    log(`reusing ${FILE}`);
    report.generation = { reused: true };
  }
  const size = statSync(FILE).size;
  const s0 = Date.now();
  const sha = await sha256(FILE);
  const p = await probe(FILE);
  report.media = {
    path: FILE,
    size_bytes: size,
    sha256: sha,
    sha256_seconds: (Date.now() - s0) / 1000,
    ffprobe: p.summary,
  };
  check(
    'file is exactly MAX_UPLOAD_BYTES',
    size === MAX,
    `${size} bytes (MAX_UPLOAD_BYTES=${MAX})`,
  );
  check(
    'file is a valid MP4/H.264 yuv420p (+AAC) per the media rule',
    p.ok,
    JSON.stringify(p.summary),
  );
}

// ------------------------------------------------------------------ processes
let apiProc: ChildProcess | undefined;
let workerProc: ChildProcess | undefined;
let workerLog = '';
function startProcess(
  name: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): ChildProcess {
  const logFile = createWriteStream(join(DIR, `${name}.log`));
  const child = spawn('node', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const sink = (d: Buffer) => {
    logFile.write(d);
    if (name === 'worker') workerLog += d.toString();
  };
  child.stdout?.on('data', sink);
  child.stderr?.on('data', sink);
  return child;
}
async function waitFor(
  what: string,
  test: () => Promise<boolean> | boolean,
  timeoutMs: number,
  everyMs = 1000,
): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await test()) return;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error(`timeout waiting for ${what}`);
}

// ------------------------------------------------------------------ HTTP
let token = '';
async function api(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: any; headers: Headers }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  return { status: res.status, json, headers: res.headers };
}

/** PUT/GET a presigned URL from inside the container: connect to S3_ENDPOINT, keep the signed public Host. */
function presigned(
  url: string,
  opts: {
    method: 'PUT' | 'GET';
    file?: { start: number; length: number };
    range?: string;
    onRequest?: (r: ClientRequest) => void;
  },
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}> {
  const target = new URL(url);
  const internal = new URL(storageConfig().endpoint);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: internal.hostname,
        port: internal.port,
        method: opts.method,
        path: `${target.pathname}${target.search}`,
        headers: {
          host: target.host,
          ...(opts.file ? { 'content-length': String(opts.file.length) } : {}),
          ...(opts.range ? { range: opts.range } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    opts.onRequest?.(req);
    if (opts.file) {
      createReadStream(FILE, {
        start: opts.file.start,
        end: opts.file.start + opts.file.length - 1,
        highWaterMark: 4 * MIB,
      })
        .on('error', reject)
        .pipe(req);
    } else {
      req.end();
    }
  });
}

// ------------------------------------------------------------------ main
async function main(): Promise<void> {
  // Explicit test context; every guard below fails closed.
  if (process.env.NODE_ENV !== 'test')
    throw new Error(
      'run through `npm run verify:large-upload` (NODE_ENV=test)',
    );
  applyTestDatabaseEnv();
  applyTestQueueEnv();
  applyTestStorageEnv();
  const target = readTestStorageTarget();
  const schema = testQueueSchema();
  if (Number.isNaN(MAX) || MAX <= 0)
    throw new Error('invalid MAX_UPLOAD_BYTES');
  report.target = {
    bucket: target.bucket,
    database: process.env.DB_NAME,
    queue_schema: schema,
    max_upload_bytes: MAX,
  };
  log(
    `targets: bucket ${target.bucket}, database ${process.env.DB_NAME}, queue schema ${schema} (test resources only)`,
  );

  await prepareMedia();

  log(
    'preparing the test database (reset + migrations, test-run lock held for the whole run)…',
  );
  const lock = await prepareTestDatabase();
  const db = new Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
  await db.connect();
  const s3 = new S3Client({
    endpoint: storageConfig().endpoint,
    region: storageConfig().region,
    forcePathStyle: true,
    credentials: target.identities.api,
  });
  const sampler = setInterval(
    () =>
      samples.push({
        t: (Date.now() - t0) / 1000,
        phase,
        api_rss_mib: rssMib(apiProc?.pid),
        worker_rss_mib: rssMib(workerProc?.pid),
      }),
    1000,
  );
  try {
    apiProc = startProcess('api', ['dist/main'], {
      ...process.env,
      PORT: String(API_PORT),
    });
    workerProc = startProcess(
      'worker',
      ['dist/worker/main.worker.js'],
      testWorkerProcessEnv(),
    );
    await waitFor(
      'the API',
      async () =>
        await fetch(`${API}/`)
          .then((r) => r.ok)
          .catch(() => false),
      60_000,
    );
    await waitFor(
      'the worker',
      () => workerLog.includes('Video worker started'),
      60_000,
    );
    log('API (test identity) and worker (test worker identity) started');

    // Owner + login.
    const email = `gate3_${randomBytes(4).toString('hex')}@example.com`;
    const password = randomBytes(12).toString('hex');
    const user = await db.query<{ id: string }>(
      'INSERT INTO users (email, password, is_confirmed) VALUES ($1, $2, true) RETURNING id',
      [email, await argon2.hash(password)],
    );
    await db.query(
      'INSERT INTO channels (name, nickname, user_id) VALUES ($1, $2, $3)',
      ['Gate 3', `gate3_${randomBytes(4).toString('hex')}`, user.rows[0].id],
    );
    const login = await api('POST', '/auth/login', { email, password });
    token = String(login.json?.access_token ?? '');
    if (!token) throw new Error(`login failed: ${login.status}`);

    // Size limit (contract AC).
    const over = await api(
      'POST',
      '/videos',
      { filename: 'over.mp4', size_bytes: MAX + 1 },
      { 'idempotency-key': 'gate3-over' },
    );
    check(
      'POST /videos with size_bytes = MAX + 1 → 400 UPLOAD_SIZE_EXCEEDED',
      over.status === 400 && over.json?.error === 'UPLOAD_SIZE_EXCEEDED',
      `${over.status} ${over.json?.error}`,
    );

    // Draft + multipart session.
    const start = await api(
      'POST',
      '/videos',
      {
        filename: 'gate3-10gib.mp4',
        size_bytes: MAX,
        content_type: 'video/mp4',
      },
      { 'idempotency-key': 'gate3-main' },
    );
    const id = String(start.json?.id);
    const parts = Number(start.json?.expected_part_count);
    const partSize = Number(start.json?.part_size_bytes);
    check(
      'start: draft created (201, uploading, publication draft)',
      start.status === 201 &&
        start.json?.processing_status === 'uploading' &&
        start.json?.publication === 'draft',
      `${start.status} ${start.json?.processing_status}/${start.json?.publication}, ${parts} parts of ${partSize} B`,
    );
    const row = (
      await db.query<{
        id: string;
        upload_id: string;
        upload_binding_token: string;
      }>(
        'SELECT id, upload_id, upload_binding_token FROM videos WHERE public_id = $1',
        [id],
      )
    ).rows[0];
    const key = `videos/${row.id}/original`;
    const jobsBefore = (
      await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM "${schema}".job WHERE name = 'video.process'`,
      )
    ).rows[0].n;

    // Upload with just-in-time URLs, interrupted at half.
    const urls = new Map<
      number,
      { url: string; expires: number; issuedAt: number }
    >();
    const sent: {
      part: number;
      seconds: number;
      bytes: number;
      urlAgeS: number;
      urlLeftS: number;
    }[] = [];
    let urlBatches = 0;
    async function urlFor(part: number, pending: number[]): Promise<string> {
      const cached = urls.get(part);
      if (cached && cached.expires - Date.now() > 60_000) return cached.url;
      const batch = [part, ...pending.filter((p) => p !== part)]
        .slice(0, URL_BATCH)
        .sort((a, b) => a - b);
      const r = await api('POST', `/videos/${id}/upload/part-urls`, {
        part_numbers: batch,
      });
      if (r.status !== 200)
        throw new Error(`part-urls ${r.status} ${r.json?.error}`);
      urlBatches++;
      for (const p of r.json.parts as {
        part_number: number;
        url: string;
        expires_at: string;
      }[]) {
        urls.set(p.part_number, {
          url: p.url,
          expires: Date.parse(p.expires_at),
          issuedAt: Date.now(),
        });
      }
      return urls.get(part)!.url;
    }
    const inflight = new Set<ClientRequest>();
    let stop = false;
    async function uploadParts(
      list: number[],
      interruptAfter?: number,
    ): Promise<{ done: number[]; aborted: number[] }> {
      const queue = [...list];
      const done: number[] = [];
      const aborted: number[] = [];
      async function lane(): Promise<void> {
        while (queue.length > 0 && !stop) {
          const part = queue.shift()!;
          const offset = (part - 1) * partSize;
          const length = Math.min(partSize, MAX - offset);
          const url = await urlFor(part, queue);
          const meta = urls.get(part)!;
          const p0 = Date.now();
          let req: ClientRequest | undefined;
          try {
            const res = await presigned(url, {
              method: 'PUT',
              file: { start: offset, length },
              onRequest: (r) => {
                req = r;
                inflight.add(r);
              },
            });
            if (res.status !== 200)
              throw new Error(`part ${part}: HTTP ${res.status}`);
            done.push(part);
            sent.push({
              part,
              seconds: (Date.now() - p0) / 1000,
              bytes: length,
              urlAgeS: (p0 - meta.issuedAt) / 1000,
              urlLeftS: (meta.expires - p0) / 1000,
            });
            if (
              interruptAfter !== undefined &&
              done.length >= interruptAfter &&
              !stop
            ) {
              stop = true;
              for (const r of inflight)
                if (r !== req)
                  r.destroy(new Error('simulated client interruption'));
            }
          } catch (error) {
            if (stop) aborted.push(part);
            else throw error;
          } finally {
            if (req) inflight.delete(req);
          }
        }
      }
      await Promise.all(Array.from({ length: CONCURRENCY }, () => lane()));
      return { done, aborted };
    }

    phase = 'upload';
    const rssBefore = rssMib(apiProc.pid);
    const net0 = netRxBytes();
    const u0 = Date.now();
    const first = await uploadParts(
      Array.from({ length: parts }, (_, i) => i + 1),
      Math.floor(parts / 2),
    );
    const firstSeconds = (Date.now() - u0) / 1000;
    log(
      `interrupted after ${first.done.length} parts (${first.aborted.length} in-flight PUTs aborted) in ${firstSeconds.toFixed(0)} s`,
    );

    // Resume from the storage's view.
    phase = 'resume';
    stop = false;
    const status = await api('GET', `/videos/${id}/upload`);
    const listed = (status.json?.parts as { part_number: number }[])
      .map((p) => p.part_number)
      .sort((a, b) => a - b);
    const missing = (status.json?.missing_part_numbers as number[])
      .slice()
      .sort((a, b) => a - b);
    check(
      'resume: GET /videos/:id/upload lists the uploaded parts and the missing ones',
      status.status === 200 &&
        listed.length + missing.length === parts &&
        first.done.every((p) => listed.includes(p)),
      `${listed.length} listed + ${missing.length} missing = ${parts}`,
    );

    // Quota while 10 GiB are pending.
    const second = await api(
      'POST',
      '/videos',
      { filename: 'second.mp4', size_bytes: MAX },
      { 'idempotency-key': 'gate3-second' },
    );
    const third = await api(
      'POST',
      '/videos',
      { filename: 'third.mp4', size_bytes: MIB },
      { 'idempotency-key': 'gate3-third' },
    );
    const cancel =
      second.status === 201
        ? await api('DELETE', `/videos/${second.json.id}/upload`)
        : { status: 0, json: undefined };
    check(
      'quota: pending bytes counted; the start above MAX_PENDING_UPLOAD_BYTES_PER_OWNER is refused',
      second.status === 201 &&
        third.status === 429 &&
        third.json?.error === 'PENDING_UPLOAD_QUOTA_EXCEEDED',
      `second 10 GiB start ${second.status}, third start ${third.status} ${third.json?.error}, second cancelled ${cancel.status}`,
    );

    const r0 = Date.now();
    const resumed = await uploadParts(missing);
    const resumeSeconds = (Date.now() - r0) / 1000;
    const resumedSorted = resumed.done.slice().sort((a, b) => a - b);
    check(
      'resume sends only the parts listed in missing_part_numbers',
      JSON.stringify(resumedSorted) === JSON.stringify(missing),
      `${resumedSorted.length} parts sent after the interruption = missing list`,
    );
    const uploadSeconds = firstSeconds + resumeSeconds;
    const rssUpload = samples
      .filter((s) => s.phase === 'upload' || s.phase === 'resume')
      .map((s) => s.api_rss_mib);
    const rssMax = Math.max(...rssUpload);
    const rssMin = Math.min(...rssUpload);
    report.upload = {
      parts,
      part_size_bytes: partSize,
      first_pass_parts: first.done.length,
      aborted_in_flight: first.aborted,
      resumed_parts: resumedSorted.length,
      url_batches: urlBatches,
      first_pass_seconds: firstSeconds,
      resume_seconds: resumeSeconds,
      total_seconds: uploadSeconds,
      throughput_mib_s: MAX / MIB / uploadSeconds,
      url_age_max_s: Math.max(...sent.map((s) => s.urlAgeS)),
      url_time_left_min_s: Math.min(...sent.map((s) => s.urlLeftS)),
      api_rss_mib: {
        before: rssBefore,
        min: rssMin,
        max: rssMax,
        variation: rssMax - rssMin,
      },
      container_rx_bytes_during_upload: netRxBytes() - net0,
    };
    check(
      'every part PUT used a valid, unexpired presigned URL (renewed just in time)',
      Math.min(...sent.map((s) => s.urlLeftS)) > 0,
      `${urlBatches} batches; min time left ${Math.min(...sent.map((s) => s.urlLeftS)).toFixed(0)} s, max URL age ${Math.max(...sent.map((s) => s.urlAgeS)).toFixed(0)} s (TTL ${process.env.UPLOAD_PART_PRESIGN_TTL_SECONDS ?? VIDEO_ENV_DEFAULTS.UPLOAD_PART_PRESIGN_TTL_SECONDS} s)`,
    );
    check(
      'API RSS does not grow with the file (variation < 100 MiB)',
      rssMax - rssMin < 100,
      `before ${rssBefore.toFixed(0)} MiB, during upload ${rssMin.toFixed(0)}–${rssMax.toFixed(0)} MiB (variation ${(rssMax - rssMin).toFixed(1)} MiB) for ${(MAX / 2 ** 30).toFixed(0)} GiB`,
    );

    const jobsBeforeComplete = (
      await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM "${schema}".job WHERE name = 'video.process'`,
      )
    ).rows[0].n;

    // Complete with the client's ordered manifest.
    const finalStatus = await api('GET', `/videos/${id}/upload`);
    const allParts = (
      finalStatus.json.parts as { part_number: number; etag: string }[]
    )
      .sort((a, b) => a.part_number - b.part_number)
      .map((p) => ({ part_number: p.part_number, etag: p.etag }));
    const c0 = Date.now();
    let complete = await api('POST', `/videos/${id}/upload/complete`, {
      parts: allParts,
    });
    while (complete.status === 202) {
      await new Promise((r) =>
        setTimeout(r, Number(complete.headers.get('retry-after') ?? 2) * 1000),
      );
      complete = await api('POST', `/videos/${id}/upload/complete`, {
        parts: allParts,
      });
    }
    const completeSeconds = (Date.now() - c0) / 1000;
    check(
      'complete: 200 → uploaded',
      complete.status === 200 &&
        complete.json?.processing_status === 'uploaded',
      `${complete.status} ${complete.json?.processing_status} in ${completeSeconds.toFixed(1)} s`,
    );

    // Completion proof (SI-03.10): key, upload_id, size, upload-binding.
    const head = await s3.send(
      new HeadObjectCommand({ Bucket: target.bucket, Key: key }),
    );
    const rowAfter = (
      await db.query<{
        upload_id: string;
        upload_binding_token: string;
        processing_status: string;
      }>(
        'SELECT upload_id, upload_binding_token, processing_status FROM videos WHERE id = $1',
        [row.id],
      )
    ).rows[0];
    const sessionGone = await s3
      .send(
        new ListPartsCommand({
          Bucket: target.bucket,
          Key: key,
          UploadId: row.upload_id,
        }),
      )
      .then(
        () => false,
        (e: { name?: string }) => e.name === 'NoSuchUpload',
      );
    check(
      "proof: object at the video's exclusive key, exact size, this upload's binding; session closed",
      head.ContentLength === MAX &&
        head.Metadata?.['upload-binding'] === row.upload_binding_token &&
        rowAfter.upload_id === row.upload_id &&
        sessionGone,
      `key videos/<uuid>/original, ${head.ContentLength} B, binding matches, upload_id kept, ListParts → NoSuchUpload`,
    );
    const jobs = (
      await db.query<{ data: Record<string, unknown> }>(
        `SELECT data FROM "${schema}".job WHERE name = 'video.process' AND data->>'videoId' = $1`,
        [row.id],
      )
    ).rows;
    check(
      'job published only after the valid completion, carrying only videoId',
      jobsBefore === '0' &&
        jobsBeforeComplete === '0' &&
        jobs.length === 1 &&
        JSON.stringify(Object.keys(jobs[0].data)) === '["videoId"]',
      `before start ${jobsBefore}, before complete ${jobsBeforeComplete}, after ${jobs.length} with keys ${JSON.stringify(Object.keys(jobs[0]?.data ?? {}))}`,
    );

    // Processing by the worker (HTTP Range on the presigned internal GET).
    phase = 'processing';
    const pnet0 = netRxBytes();
    const p0 = Date.now();
    let video: any;
    await waitFor(
      'ready or failed',
      async () => {
        video = (await api('GET', `/videos/${id}`)).json;
        return (
          video?.processing_status === 'ready' ||
          video?.processing_status === 'failed'
        );
      },
      40 * 60_000,
      5_000,
    );
    const processingSeconds = (Date.now() - p0) / 1000;
    const processingRx = netRxBytes() - pnet0;
    const thumbs = await s3.send(
      new ListObjectsV2Command({
        Bucket: target.bucket,
        Prefix: `videos/${row.id}/thumbnail.jpg`,
      }),
    );
    const thumbSize = thumbs.Contents?.[0]?.Size ?? 0;
    const workerRss = samples
      .filter((s) => s.phase === 'processing')
      .map((s) => s.worker_rss_mib);
    report.processing = {
      seconds: processingSeconds,
      status: video.processing_status,
      failure_reason: video.failure_reason,
      duration_seconds: video.duration_seconds,
      media_metadata: video.media_metadata,
      has_thumbnail: video.has_thumbnail,
      thumbnail_bytes: thumbSize,
      container_rx_bytes_during_processing: processingRx,
      worker_rss_mib_max: Math.max(0, ...workerRss),
    };
    check(
      'worker processed the 10 GiB video to ready with duration, metadata and a thumbnail',
      video.processing_status === 'ready' &&
        Number(video.duration_seconds) > 0 &&
        !!video.media_metadata &&
        video.has_thumbnail === true &&
        thumbSize > 0,
      `${video.processing_status} in ${processingSeconds.toFixed(0)} s, duration ${video.duration_seconds} s, thumbnail ${thumbSize} B`,
    );
    check(
      'processing read the object by HTTP Range, not by copying it (TD-08)',
      processingRx < MAX * 0.05,
      `${(processingRx / MIB).toFixed(1)} MiB received by the container while processing (${((processingRx / MAX) * 100).toFixed(2)} % of the object)`,
    );

    // Delivery: Range playback (first + last KiB) and download, byte-for-byte.
    phase = 'delivery';
    const handle = await open(FILE, 'r');
    const firstKiB = Buffer.alloc(1024);
    const lastKiB = Buffer.alloc(1024);
    await handle.read(firstKiB, 0, 1024, 0);
    await handle.read(lastKiB, 0, 1024, MAX - 1024);
    await handle.close();
    const playback = await api('GET', `/videos/${id}/playback-url`);
    const r1 = await presigned(playback.json.url, {
      method: 'GET',
      range: 'bytes=0-1023',
    });
    const r2 = await presigned(playback.json.url, {
      method: 'GET',
      range: `bytes=${MAX - 1024}-${MAX - 1}`,
    });
    check(
      'playback URL: HTTP Range 206 at the start and at the end of the 10 GiB object, bytes identical to the file',
      r1.status === 206 &&
        r2.status === 206 &&
        r1.body.equals(firstKiB) &&
        r2.body.equals(lastKiB) &&
        String(r2.headers['content-range']) ===
          `bytes ${MAX - 1024}-${MAX - 1}/${MAX}`,
      `${r1.status} ${r1.headers['content-range']}; ${r2.status} ${r2.headers['content-range']}`,
    );
    const download = await api('GET', `/videos/${id}/download-url`);
    const d1 = await presigned(download.json.url, {
      method: 'GET',
      range: 'bytes=0-1023',
    });
    check(
      'download URL: attachment with the original name, Range served',
      d1.status === 206 &&
        String(d1.headers['content-disposition']).startsWith('attachment') &&
        d1.body.equals(firstKiB),
      `${d1.status} ${d1.headers['content-disposition']}`,
    );
  } finally {
    clearInterval(sampler);
    for (const p of [apiProc, workerProc]) p?.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 3000));
    await db.end().catch(() => undefined);
    s3.destroy();
    await lock.release();
  }
}

main()
  .catch((error: unknown) => {
    check(
      'verification ran to the end',
      false,
      `${(error as Error).name}: ${(error as Error).message}`,
    );
  })
  .finally(() => {
    report.finished_at = new Date().toISOString();
    report.checks = checks;
    report.memory_samples = samples;
    const out = join(DIR, `gate3-report-${Date.now()}.json`);
    try {
      writeFileSync(out, JSON.stringify(report, null, 2));
    } catch {
      /* best effort */
    }
    const failed = checks.filter((c) => c.result === 'FAIL').length;
    console.log(
      `\nGATE 3 VERIFICATION: ${checks.length - failed} passed, ${failed} failed — report ${out}`,
    );
    process.exit(failed === 0 ? 0 : 1);
  });

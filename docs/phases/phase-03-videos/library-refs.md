---
libs:
  "@aws-sdk/client-s3":
    version: "^3.x"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-11-11T18:10:29-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.x"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-11-11T18:10:29-03:00"
  "pg-boss":
    version: "^12.x"
    context7_id: "/timgit/pg-boss"
    fetched_at: "2026-11-11T18:10:29-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-12T18:55:32-03:00"
---

# phase-03-videos — Library references

_Distilled from Context7 for the surfaces the decided TDs use. Context7 indexed `pg-boss` at `12.27.0`, while the research probed registry `12.38.2` (Node ≥22.12, PostgreSQL ≥13); confirm the installed version's API at implementation. The AWS SDK repo snapshot lists tags up to `v3.1153.0`, while the probe used `3.1167.0`._

## Documented (Context7) vs researched versions

| Library | Context7 snapshot (documentation) | Version researched/probed in this phase | Declared range (TDs) |
|---|---|---|---|
| `@aws-sdk/client-s3` | repo `aws/aws-sdk-js-v3`, tags listed up to `v3.1153.0` | registry `3.1166.0`; probe installed `3.1167.0` | `^3.x` |
| `@aws-sdk/s3-request-presigner` | same repo and snapshot | registry/probe `3.1166.0` | `^3.x` |
| `pg-boss` | `12.27.0` | registry `12.38.2` (Node ≥22.12, PostgreSQL ≥13) | `^12.x` |

The documented snapshots are older than the researched versions. The API surface below comes from the snapshots; the versions actually installed at implementation must be re-checked against it.

## Not yet proven — TypeORM + pg-boss

The Context7 documentation shows `send({ db })` composing inside a caller-owned transaction only for the **Knex, Kysely and Drizzle** adapters. **No TypeORM adapter is documented, and the integration of TypeORM with `pg-boss` was not exercised** in this phase's research. It remains one of the eight pending validations (TD-05): same-transaction enqueue, rollback, commit and durable recovery must be demonstrated by the planning spike before it is relied upon.

> **Later evidence (added 2026-11-13; the paragraph above is the original note, kept as written).** The spike proved the integration. Evidence: SI-03.1, `spike-pgboss.md`, Verification Gate 1, PASS, approved by the user on 2026-11-11, commit `4fc0aec`.
>
> - **What it proved:** all eight TD-05 conditions passed with the versions actually installed (`pg-boss` 12.38.2, `pg` 8.23.1, `typeorm` 0.3.28):
>   - same-transaction enqueue;
>   - no job on rollback;
>   - commit keeps both the row and the job;
>   - deterministic schema;
>   - isolated test schema;
>   - dedupe, retries and recovery after `SIGKILL`;
>   - no transaction open while a video is processed.
> - **How:** `send(…, { db })` runs on the TypeORM `EntityManager` of `dataSource.transaction()` through `src/queue/typeorm-pgboss-db.adapter.ts`. The adapter refuses a manager without an active transaction.
> - **Where it is used:** `UploadRecoveryService.markUploaded` moves the video to `uploaded` and publishes `video.process` in one transaction.
> - **Later confirmations:**
>   - Gates 4–5 (`gate-04-05-completion.md`);
>   - Gate 3, criterion 10 (`verification-10gib.md`: 0 jobs before completion, exactly 1 after, payload `{ videoId }`).
> - **Versions:** the installed AWS SDK (`^3.1167.0`) and `pg-boss` (`^12.38.2`) are in `nestjs-project/package.json`.
>
> The versions and API surface below are the planning snapshot and are not edited.


### @aws-sdk/client-s3

Used by phase-03-videos/TD-04 (and TD-01, TD-02, TD-08, TD-11, TD-14).

- **Client with a custom endpoint and path-style addressing** (MinIO-compatible; the bucket goes in the path, not the subdomain):

  ```typescript
  const client = new S3Client({
    endpoint: 'http://minio:9000',
    forcePathStyle: true,
    region: 'us-east-1',
    credentials: { accessKeyId, secretAccessKey },
  });
  ```

- **Checksums.** `requestChecksumCalculation` and `responseChecksumValidation` accept `WHEN_REQUIRED` or `WHEN_SUPPORTED`. With `WHEN_REQUIRED` and no algorithm set by the caller, no checksum is added; `UploadPartCommand` is configured with `requestChecksumRequired: false`, so the default checksum is added only under `WHEN_SUPPORTED`. (The research measured that the default adds `x-amz-checksum-crc32` query parameters to presigned URLs; `WHEN_REQUIRED` removes them.)
- **Multipart commands:** `CreateMultipartUploadCommand`, `UploadPartCommand` (`Bucket`, `Key`, `UploadId`, `PartNumber`, `Body`), `ListPartsCommand` (paginate with `PartNumberMarker` / `NextPartNumberMarker`), `CompleteMultipartUploadCommand` (`MultipartUpload: { Parts: [{ PartNumber, ETag }] }`) and `AbortMultipartUploadCommand`. Part numbers are positive integers from 1 to 10,000. Every part except the last must be at least 5 MiB.
- **`ETag` per part.** `UploadPart` returns the part's `ETag`; the SDK's own uploader throws when it is missing and hints at a missing CORS `ETag` exposure — relevant to the browser-side flow recorded in TD-02.
- **`HeadObjectCommand`** returns `ContentLength`, `ETag`, `ContentType`, `AcceptRanges` without downloading the body — used for the size check after completion (TD-02).
- **`GetObjectCommand`** accepts `Range`, `ResponseContentDisposition`, `ResponseContentType` among other input fields (TD-11).

### @aws-sdk/s3-request-presigner

Used by phase-03-videos/TD-04 and TD-11.

- `getSignedUrl(client, command, { expiresIn })` returns the presigned URL; `expiresIn` is in seconds and defaults to `900` when omitted.

  ```javascript
  import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
  import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
  const url = await getSignedUrl(client, new GetObjectCommand(params), { expiresIn: 3600 });
  ```

- Works for any command, including `UploadPartCommand` (one URL per part) and `GetObjectCommand` with `ResponseContentDisposition` for the download URL.
- `x-amz-*` headers you want enforced must be listed in `unhoistableHeaders`; non-`x-amz-*` headers go in `signableHeaders`. The signature is bound to the host the client was configured with — emit the URL from a client configured with the **public** endpoint (TD-04).

### pg-boss

Used by phase-03-videos/TD-05 (and TD-06, TD-14).

- **Start and queues:**

  ```javascript
  import { PgBoss } from 'pg-boss';
  const boss = new PgBoss('postgres://user:pass@host/database');
  boss.on('error', console.error);
  await boss.start();            // creates its own schema; the DB user needs permission to create a schema
  await boss.createQueue('video-process');
  ```

- **Worker:** `boss.work(name, options, handler)`; the handler receives an **array** of jobs. Options include `localConcurrency`, `pollingIntervalSeconds`, `batchSize`. A job exposes `id`, `name`, `data`, `retryCount`, `heartbeatSeconds` and an `AbortSignal` that fires on `expireInSeconds`, shutdown, or a lost heartbeat. An unhandled error fails the job automatically.
- **Transactional enqueue (the TD-05 validation condition).** `send(name, data, { db })` runs the `INSERT` directly on the supplied connection without its own `BEGIN`/`COMMIT`, so it participates in the caller's open transaction. `db` accepts anything implementing `executeSql(text, values)`. Documented adapters exist for Knex (`fromKnex`), Kysely (`fromKysely`) and Drizzle (`fromDrizzle`); **there is no TypeORM adapter in the docs**, so the planning spike must verify a small `executeSql` wrapper over the TypeORM `QueryRunner`/`EntityManager` (rollback discards the job; commit keeps it).

  ```javascript
  await knex.transaction(async (trx) => {
    await trx('orders').insert({ item: 'widget', qty: 1 });
    await boss.send('order-processing', { item: 'widget' }, { db: fromKnex(trx) });
  });
  ```

- **Transactional worker:** `boss.work(name, { transactional: true }, async (jobs, tx) => { ... })` commits the handler's writes (through `tx.executeSql`) together with the job's completion; on a throw the writes roll back and the job is failed.
- **Retries and singletons:** `retryLimit`, `retryBackoff` and `singletonKey` are send/queue options (see the pg-boss API docs when implementing); `key_strict_fifo` queues require a `singletonKey`.
- **Shutdown:** `await boss.stop()` waits gracefully for active jobs (default `timeout` 30000 ms); `{ graceful: false }` aborts active jobs; `{ close: false }` keeps the pool open for `send()`/`fetch()`.
- **Start failures:** `start()` rejects when the database is unavailable; pass `attempts` to retry with backoff; once started, workers ride out a dropped database and resume.

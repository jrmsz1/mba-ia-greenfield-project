import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import {
  StorageError,
  StorageRejectedError,
  UploadNotFoundError,
} from '../storage/storage-errors';
import { originalKey } from '../storage/storage-key';
import {
  StorageService,
  type ManifestPart,
  type ObjectHead,
  type StoredPart,
} from '../storage/storage.service';
import { contradictionOf, evaluateCompletionProof } from './completion-proof';
import { Video } from './entities/video.entity';
import { UploadRecoveryService } from './upload-recovery.service';
import type { VideoProcessingStatus } from './video.constants';
import {
  InvalidVideoStateException,
  ManifestInvalidException,
  StorageUnavailableException,
  UploadExpiredException,
  UploadPartsMismatchException,
} from './video.exceptions';
import { firstRows } from './windowed-counter';

export interface CompletionResult {
  /** `done` → 200; `pending` → 202 with Retry-After (outcome not proven yet). */
  outcome: 'done' | 'pending';
  processingStatus: VideoProcessingStatus;
}

const PAST_UPLOAD = new Set(['uploaded', 'processing', 'ready']);
const TERMINAL = new Set(['failed', 'expired', 'cancelled']);

const unquote = (etag: string): string => etag.replace(/^"|"$/g, '');

/**
 * Upload completion protocol of phase-03-videos/TD-02 (plan SI-03.10):
 * verify the manifest against paginated ListParts → claim
 * `uploading → completing` (compare-and-set) → CompleteMultipartUpload →
 * completion proof → `uploaded` + job in one transaction. An unknown outcome
 * keeps `completing`; only evidence moves the row.
 */
@Injectable()
export class VideoCompletionService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly storage: StorageService,
    private readonly recovery: UploadRecoveryService,
  ) {}

  async complete(
    video: Video,
    manifest: ManifestPart[],
  ): Promise<CompletionResult> {
    if (video.processing_status !== 'completing') {
      return await this.run(video, manifest);
    }
    // Retried complete after an unknown outcome (TD-02 step 7): resolve with
    // evidence only — never with the client's unverified manifest. When the
    // session is still open and no object exists, the claim is released and
    // the protocol runs again; a Complete still in flight is harmless (on the
    // pinned build concurrent Completes give one success, NoSuchUpload for the
    // rest, and the proof decides).
    const outcome = await this.recovery.resolve(video.id, {
      allowRelease: true,
    });
    if (outcome !== 'released') return await this.currentResult(video.id);
    return await this.run(await this.reload(video.id), manifest);
  }

  private async run(
    video: Video,
    manifest: ManifestPart[],
  ): Promise<CompletionResult> {
    const settled = this.settledResult(video);
    if (settled) return settled;
    if (video.upload_expires_at.getTime() <= Date.now()) {
      throw new UploadExpiredException();
    }
    if (!video.upload_id) {
      throw new InvalidVideoStateException(video.processing_status);
    }
    this.assertManifestShape(video, manifest);

    // (3) Read-only verification; a transport error claims nothing.
    const key = originalKey(video.id);
    let stored: StoredPart[];
    try {
      stored = await this.storage.listParts(key, video.upload_id);
    } catch (error) {
      if (error instanceof UploadNotFoundError) {
        // The manifest could not be verified: resolve on storage evidence only.
        await this.recovery.resolve(video.id);
        return await this.currentResult(video.id);
      }
      if (error instanceof StorageError)
        throw new StorageUnavailableException();
      throw error;
    }
    this.assertManifestMatches(video, manifest, stored);

    // (4) Claim: exactly one caller wins.
    const claimed: unknown[] = await this.dataSource.query(
      `UPDATE "videos" SET "processing_status" = 'completing', "completing_since" = now()
       WHERE id = $1 AND "processing_status" = 'uploading'
       RETURNING id`,
      [video.id],
    );
    if (firstRows(claimed).length === 0) {
      const current = await this.reload(video.id);
      return (
        this.settledResult(current) ?? {
          outcome: 'pending',
          processingStatus: current.processing_status,
        }
      );
    }

    // (5) Complete; classify the outcome by S3 error code.
    try {
      await this.storage.completeMultipartUpload(
        key,
        video.upload_id,
        manifest,
      );
    } catch (error) {
      if (error instanceof UploadNotFoundError) {
        await this.recovery.resolve(video.id, { manifest });
        return await this.currentResult(video.id);
      }
      if (error instanceof StorageRejectedError) {
        // Definitive: the object was not created — release the claim.
        await this.recovery.transition(
          video.id,
          ['completing'],
          'uploading',
          null,
        );
        throw new UploadPartsMismatchException(
          manifest.map((p) => p.partNumber),
          error.code,
        );
      }
      if (error instanceof StorageError) {
        // Transient or ambiguous: outcome unknown, the row stays `completing`.
        return { outcome: 'pending', processingStatus: 'completing' };
      }
      throw error;
    }

    // (6) Proof, then `completing → uploaded` + job.
    return await this.finish(video, manifest);
  }

  private async finish(
    video: Video,
    manifest: ManifestPart[],
  ): Promise<CompletionResult> {
    const { upload_binding_token: token } = await this.recovery.loadWithToken(
      video.id,
    );
    let head: ObjectHead | null;
    try {
      head = await this.storage.headObject(originalKey(video.id));
    } catch (error) {
      if (error instanceof StorageError) {
        return { outcome: 'pending', processingStatus: 'completing' };
      }
      throw error;
    }
    const input = {
      head,
      declaredSizeBytes: video.declared_size_bytes,
      bindingToken: token,
      manifest,
    };
    const proof = evaluateCompletionProof(input);
    const contradiction = contradictionOf(input);
    if (proof === 'proven') {
      await this.recovery.markUploaded(video.id, ['completing']);
    } else if (proof === 'contradicted' && head && contradiction) {
      await this.recovery.markInvalid(
        video.id,
        ['completing'],
        contradiction,
        head,
      );
    }
    return await this.currentResult(video.id);
  }

  /**
   * 200 for a video past `uploading`, 409 for a terminal one, pending for a
   * claim held by another caller, null when the protocol must run.
   */
  private settledResult(video: Video): CompletionResult | null {
    if (PAST_UPLOAD.has(video.processing_status)) {
      return { outcome: 'done', processingStatus: video.processing_status };
    }
    if (TERMINAL.has(video.processing_status)) {
      throw new InvalidVideoStateException(video.processing_status);
    }
    if (video.processing_status === 'completing') {
      return { outcome: 'pending', processingStatus: 'completing' };
    }
    return null;
  }

  /**
   * Result from the row as it stands after a resolution: past `uploading` is
   * `done`, a terminal row is a 409 (the contract never answers 200 for it),
   * anything else is still `pending`.
   */
  private async currentResult(videoId: string): Promise<CompletionResult> {
    const current = await this.reload(videoId);
    if (TERMINAL.has(current.processing_status)) {
      throw new InvalidVideoStateException(current.processing_status);
    }
    return {
      outcome: PAST_UPLOAD.has(current.processing_status) ? 'done' : 'pending',
      processingStatus: current.processing_status,
    };
  }

  private assertManifestShape(video: Video, manifest: ManifestPart[]): void {
    const ascending = manifest.every((p, i) => p.partNumber === i + 1);
    if (manifest.length !== video.expected_part_count || !ascending) {
      throw new ManifestInvalidException(video.expected_part_count);
    }
  }

  private assertManifestMatches(
    video: Video,
    manifest: ManifestPart[],
    stored: StoredPart[],
  ): void {
    const byNumber = new Map(stored.map((p) => [p.partNumber, p]));
    const bad = new Set<number>();
    const last = video.expected_part_count;
    let total = 0;
    for (const part of manifest) {
      const found = byNumber.get(part.partNumber);
      if (!found || unquote(found.etag) !== unquote(part.etag)) {
        bad.add(part.partNumber);
        continue;
      }
      const sizeOk =
        part.partNumber < last
          ? found.sizeBytes === video.part_size_bytes
          : found.sizeBytes <= video.part_size_bytes;
      if (!sizeOk) bad.add(part.partNumber);
      total += found.sizeBytes;
    }
    for (const p of stored) {
      if (p.partNumber > last) bad.add(p.partNumber); // extra parts
    }
    if (bad.size === 0 && total !== video.declared_size_bytes) {
      bad.add(last);
    }
    if (bad.size > 0) {
      throw new UploadPartsMismatchException([...bad].sort((a, b) => a - b));
    }
  }

  private async reload(videoId: string): Promise<Video> {
    return await this.dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: videoId });
  }
}

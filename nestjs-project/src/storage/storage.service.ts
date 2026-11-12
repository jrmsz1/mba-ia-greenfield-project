import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListPartsCommand,
  PutObjectCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import type { S3Clients } from './s3-clients.provider';
import { classifyStorageError } from './storage-errors';
import {
  S3_CLIENTS,
  STORAGE_TIMEOUTS,
  UPLOAD_BINDING_METADATA_KEY,
} from './storage.constants';

export interface StoredPart {
  partNumber: number;
  sizeBytes: number;
  etag: string;
}

export interface ObjectHead {
  contentLength: number;
  etag: string;
  uploadBinding: string | undefined;
}

export interface ManifestPart {
  partNumber: number;
  etag: string;
}

/**
 * Typed wrapper of every S3 operation phase 03 uses (phase-03-videos/TD-02,
 * TD-04, TD-08, TD-11). Every failure is rethrown as a classified
 * `StorageError` (see storage-errors.ts); every call is bounded by the
 * timeout policy in storage.constants.ts.
 */
@Injectable()
export class StorageService {
  constructor(
    @Inject(S3_CLIENTS) private readonly clients: S3Clients,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  get bucket(): string {
    return this.config.bucket;
  }

  async createMultipartUpload(
    key: string,
    bindingToken: string,
    contentType?: string,
  ): Promise<string> {
    const output = await this.run(() =>
      this.clients.singleAttempt.send(
        new CreateMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          ContentType: contentType,
          Metadata: { [UPLOAD_BINDING_METADATA_KEY]: bindingToken },
        }),
        this.callOptions(),
      ),
    );
    if (!output.UploadId) {
      throw classifyStorageError(
        new Error('CreateMultipartUpload returned no UploadId'),
      );
    }
    return output.UploadId;
  }

  /** All parts of an upload, following `NextPartNumberMarker` pagination. */
  async listParts(
    key: string,
    uploadId: string,
    pageSize?: number,
  ): Promise<StoredPart[]> {
    const parts: StoredPart[] = [];
    let marker: string | undefined;
    do {
      const page = await this.run(() =>
        this.clients.internal.send(
          new ListPartsCommand({
            Bucket: this.bucket,
            Key: key,
            UploadId: uploadId,
            PartNumberMarker: marker,
            MaxParts: pageSize,
          }),
          this.callOptions(),
        ),
      );
      for (const part of page.Parts ?? []) {
        parts.push({
          partNumber: part.PartNumber ?? 0,
          sizeBytes: part.Size ?? 0,
          etag: part.ETag ?? '',
        });
      }
      marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
    } while (marker);
    return parts;
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    manifest: ManifestPart[],
  ): Promise<void> {
    await this.run(() =>
      this.clients.singleAttempt.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: manifest.map((p) => ({
              PartNumber: p.partNumber,
              ETag: p.etag,
            })),
          },
        }),
        this.callOptions(),
      ),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.run(() =>
      this.clients.internal.send(
        new AbortMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
        }),
        this.callOptions(),
      ),
    );
  }

  /** Upload ids of every open session for exactly `key` (paginated). */
  async listMultipartUploads(key: string): Promise<string[]> {
    const ids: string[] = [];
    let keyMarker: string | undefined;
    let uploadIdMarker: string | undefined;
    do {
      const page = await this.run(() =>
        this.clients.internal.send(
          new ListMultipartUploadsCommand({
            Bucket: this.bucket,
            Prefix: key,
            KeyMarker: keyMarker,
            UploadIdMarker: uploadIdMarker,
          }),
          this.callOptions(),
        ),
      );
      for (const upload of page.Uploads ?? []) {
        if (upload.Key === key && upload.UploadId) ids.push(upload.UploadId);
      }
      if (page.IsTruncated) {
        keyMarker = page.NextKeyMarker;
        uploadIdMarker = page.NextUploadIdMarker;
      } else {
        keyMarker = undefined;
      }
    } while (keyMarker);
    return ids;
  }

  /** `null` when the object does not exist (404). */
  async headObject(key: string): Promise<ObjectHead | null> {
    try {
      const output = await this.clients.internal.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
        { abortSignal: AbortSignal.timeout(STORAGE_TIMEOUTS.REQUEST_MS) },
      );
      return {
        contentLength: output.ContentLength ?? 0,
        etag: output.ETag ?? '',
        uploadBinding: output.Metadata?.[UPLOAD_BINDING_METADATA_KEY],
      };
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } })
        .$metadata?.httpStatusCode;
      if (status === 404) return null;
      throw classifyStorageError(error);
    }
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.run(() =>
      this.clients.internal.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
        this.callOptions(),
      ),
    );
  }

  async deleteObject(key: string): Promise<void> {
    await this.run(() =>
      this.clients.internal.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
        this.callOptions(),
      ),
    );
  }

  /** Part URL signed for the public endpoint (TD-01, TD-04). */
  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    ttlSeconds: number,
  ): Promise<string> {
    return await getSignedUrl(
      this.clients.publicSigner,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: ttlSeconds },
    );
  }

  /** GET signed for the public endpoint, optionally forcing a download name (TD-11). */
  async presignGet(
    key: string,
    ttlSeconds: number,
    options: { contentDisposition?: string } = {},
  ): Promise<string> {
    return await getSignedUrl(
      this.clients.publicSigner,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: options.contentDisposition,
      }),
      { expiresIn: ttlSeconds },
    );
  }

  /** GET signed for the internal endpoint — worker processing input (TD-08). */
  async presignInternalGet(key: string, ttlSeconds: number): Promise<string> {
    return await getSignedUrl(
      this.clients.internal,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: ttlSeconds },
    );
  }

  private callOptions(): { abortSignal: AbortSignal } {
    return { abortSignal: AbortSignal.timeout(STORAGE_TIMEOUTS.REQUEST_MS) };
  }

  /** Runs one SDK call and rethrows any failure as a classified StorageError. */
  private async run<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw classifyStorageError(error);
    }
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateVideos1794453245701 implements MigrationInterface {
  name = 'CreateVideos1794453245701';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."video_publication" AS ENUM('draft')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."video_processing_status" AS ENUM('uploading', 'completing', 'uploaded', 'processing', 'ready', 'failed', 'expired', 'cancelled')`,
    );
    await queryRunner.query(
      `CREATE TABLE "videos" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "public_id" character varying(11) NOT NULL, "channel_id" uuid NOT NULL, "publication" "public"."video_publication" NOT NULL DEFAULT 'draft', "processing_status" "public"."video_processing_status" NOT NULL, "failure_reason" character varying(64), "idempotency_key" character varying(128) NOT NULL, "original_filename" character varying(255) NOT NULL, "content_type_hint" character varying(127), "declared_size_bytes" bigint NOT NULL, "part_size_bytes" bigint NOT NULL, "expected_part_count" integer NOT NULL, "upload_id" character varying(1024), "multipart_create_attempted_at" TIMESTAMP WITH TIME ZONE, "upload_binding_token" character varying(64) NOT NULL, "part_urls_issued" integer NOT NULL DEFAULT '0', "delivery_urls_issued" integer NOT NULL DEFAULT '0', "delivery_window_started_at" TIMESTAMP WITH TIME ZONE, "control_calls_issued" integer NOT NULL DEFAULT '0', "control_window_started_at" TIMESTAMP WITH TIME ZONE, "upload_expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "completing_since" TIMESTAMP WITH TIME ZONE, "duration_seconds" numeric(12,3), "media_metadata" jsonb, "thumbnail_generated_at" TIMESTAMP WITH TIME ZONE, "processing_attempts" integer NOT NULL DEFAULT '0', "processing_started_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_39a1f0fe7991162aace659078ec" UNIQUE ("public_id"), CONSTRAINT "CHK_videos_expected_part_count_range" CHECK ("expected_part_count" BETWEEN 1 AND 10000), CONSTRAINT "CHK_videos_declared_size_positive" CHECK ("declared_size_bytes" > 0), CONSTRAINT "PK_e4c86c0cf95aff16e9fb8220f6b" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_350c48c9093177350f2c50e650" ON "videos" ("channel_id", "created_at") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_8c357ceb14124c5ee2da2d6deb" ON "videos" ("processing_status", "completing_since") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_b71d982dcca7a43c065ee51aaa" ON "videos" ("processing_status", "upload_expires_at") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_bee076e56ba6ea95ab5d6f681b" ON "videos" ("channel_id", "processing_status") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_907a4f30fcebe51b93ccc3e1f4" ON "videos" ("channel_id", "idempotency_key") `,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ADD CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "videos" DROP CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_907a4f30fcebe51b93ccc3e1f4"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_bee076e56ba6ea95ab5d6f681b"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_b71d982dcca7a43c065ee51aaa"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_8c357ceb14124c5ee2da2d6deb"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_350c48c9093177350f2c50e650"`,
    );
    await queryRunner.query(`DROP TABLE "videos"`);
    await queryRunner.query(`DROP TYPE "public"."video_processing_status"`);
    await queryRunner.query(`DROP TYPE "public"."video_publication"`);
  }
}

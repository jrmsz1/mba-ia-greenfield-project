import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `videos.title` (MBA brief: the videos table holds at least a title).
 * Non-destructive: the table is altered, never recreated. Existing rows get
 * the title the application would have given them (`resolveTitle` in
 * src/videos/video-title.ts: the file name without its extension, or the
 * whole name when nothing is left), then the column becomes NOT NULL. No other
 * column is touched.
 */
export class AddVideoTitle1794622489462 implements MigrationInterface {
  name = 'AddVideoTitle1794622489462';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "videos" ADD "title" character varying(100)`,
    );
    await queryRunner.query(
      `UPDATE "videos"
          SET "title" = left(
                coalesce(
                  nullif(btrim(regexp_replace("original_filename", '\\.[^.]*$', '')), ''),
                  "original_filename"),
                100)
        WHERE "title" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "videos" ALTER COLUMN "title" SET NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "videos" DROP COLUMN "title"`);
  }
}

import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  type ValueTransformer,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import {
  VIDEO_PROCESSING_STATUSES,
  VIDEO_PUBLICATIONS,
  type MediaMetadata,
  type VideoProcessingStatus,
  type VideoPublication,
} from '../video.constants';

/** PostgreSQL bigint/numeric arrive as strings; every value here is < 2^53. */
const numberTransformer: ValueTransformer = {
  to: (value: number | null | undefined) => value,
  from: (value: string | null) => (value === null ? null : Number(value)),
};

/**
 * Draft video and its upload/processing lifecycle (phase-03-videos plan,
 * §Data Model → Video; TD-02, TD-09, TD-10, TD-13).
 */
@Entity('videos')
@Index(['channel_id', 'idempotency_key'], { unique: true })
@Index(['channel_id', 'processing_status'])
@Index(['processing_status', 'upload_expires_at'])
@Index(['processing_status', 'completing_since'])
@Index(['channel_id', 'created_at'])
@Check('CHK_videos_declared_size_positive', '"declared_size_bytes" > 0')
@Check(
  'CHK_videos_expected_part_count_range',
  '"expected_part_count" BETWEEN 1 AND 10000',
)
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 11, unique: true })
  public_id: string;

  @Column({ type: 'uuid' })
  channel_id: string;

  @Column({
    type: 'enum',
    enum: VIDEO_PUBLICATIONS,
    enumName: 'video_publication',
    default: 'draft',
  })
  publication: VideoPublication;

  @Column({
    type: 'enum',
    enum: VIDEO_PROCESSING_STATUSES,
    enumName: 'video_processing_status',
  })
  processing_status: VideoProcessingStatus;

  @Column({ type: 'varchar', length: 64, nullable: true })
  failure_reason: string | null;

  @Column({ type: 'varchar', length: 128 })
  idempotency_key: string;

  /** Given at upload start or derived from the file name (video-title.ts). */
  @Column({ type: 'varchar', length: 100 })
  title: string;

  @Column({ type: 'varchar', length: 255 })
  original_filename: string;

  @Column({ type: 'varchar', length: 127, nullable: true })
  content_type_hint: string | null;

  @Column({ type: 'bigint', transformer: numberTransformer })
  declared_size_bytes: number;

  @Column({ type: 'bigint', transformer: numberTransformer })
  part_size_bytes: number;

  @Column({ type: 'integer' })
  expected_part_count: number;

  @Column({ type: 'varchar', length: 1024, nullable: true })
  upload_id: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  multipart_create_attempted_at: Date | null;

  /** Binds the final object to this session (TD-02); loaded only where needed. */
  @Column({ type: 'varchar', length: 64, select: false })
  upload_binding_token: string;

  @Column({ type: 'integer', default: 0 })
  part_urls_issued: number;

  @Column({ type: 'integer', default: 0 })
  delivery_urls_issued: number;

  @Column({ type: 'timestamptz', nullable: true })
  delivery_window_started_at: Date | null;

  @Column({ type: 'integer', default: 0 })
  control_calls_issued: number;

  @Column({ type: 'timestamptz', nullable: true })
  control_window_started_at: Date | null;

  @Column({ type: 'timestamptz' })
  upload_expires_at: Date;

  @Column({ type: 'timestamptz', nullable: true })
  completing_since: Date | null;

  @Column({
    type: 'numeric',
    precision: 12,
    scale: 3,
    nullable: true,
    transformer: numberTransformer,
  })
  duration_seconds: number | null;

  @Column({ type: 'jsonb', nullable: true })
  media_metadata: MediaMetadata | null;

  @Column({ type: 'timestamptz', nullable: true })
  thumbnail_generated_at: Date | null;

  @Column({ type: 'integer', default: 0 })
  processing_attempts: number;

  @Column({ type: 'timestamptz', nullable: true })
  processing_started_at: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;

  // Unidirectional on purpose: no flow navigates channel -> videos (queries use
  // channel_id), and an inverse side would couple every Channel data source
  // (other modules, their tests) to the Video entity.
  @ManyToOne(() => Channel, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;
}

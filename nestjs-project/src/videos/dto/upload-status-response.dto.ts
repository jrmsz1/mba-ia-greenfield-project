import { ApiProperty } from '@nestjs/swagger';

export class PartUrlDto {
  @ApiProperty({ example: 1 })
  part_number: number;

  @ApiProperty({ description: 'Presigned UploadPart URL (public endpoint)' })
  url: string;

  @ApiProperty({ format: 'date-time' })
  expires_at: string;
}

export class PartUrlsResponseDto {
  @ApiProperty({ type: [PartUrlDto] })
  parts: PartUrlDto[];
}

export class StoredPartDto {
  @ApiProperty({ example: 1 })
  part_number: number;

  @ApiProperty({ example: 67108864 })
  size_bytes: number;

  @ApiProperty({ example: '"9b2cf535f27731c974343645a3985328"' })
  etag: string;
}

/** Response of GET /videos/:id/upload (status/resume). */
export class UploadStatusResponseDto {
  @ApiProperty({ example: 'uploading' })
  processing_status: string;

  @ApiProperty({ example: 67108864 })
  part_size_bytes: number;

  @ApiProperty({ example: 160 })
  expected_part_count: number;

  @ApiProperty({ format: 'date-time' })
  upload_expires_at: string;

  @ApiProperty({ type: [StoredPartDto] })
  parts: StoredPartDto[];

  @ApiProperty({ type: [Number], example: [2, 3] })
  missing_part_numbers: number[];
}

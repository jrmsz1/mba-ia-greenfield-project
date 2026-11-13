import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  Min,
} from 'class-validator';

/** Body of POST /videos/:id/upload/part-urls (plan §API Contracts). */
export class PartUrlsDto {
  /** 1..100 distinct part numbers, each within 1..expected_part_count. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  part_numbers: number[];
}

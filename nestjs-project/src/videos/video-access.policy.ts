import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { Video } from './entities/video.entity';
import { PUBLIC_ID_PATTERN } from './video.constants';
import { VideoNotFoundException } from './video.exceptions';

/**
 * The single ownership policy of phase-03-videos/TD-12: a video is visible
 * only to the user owning its channel. Malformed ids, unknown ids and other
 * channels' videos are indistinguishable (404 VIDEO_NOT_FOUND). Phases 04–05
 * extend this function (published videos), not the callers.
 */
@Injectable()
export class VideoAccessPolicy {
  constructor(
    @InjectRepository(Video) private readonly videos: Repository<Video>,
  ) {}

  async findOwnedVideoOrThrow(
    publicId: string,
    userId: string,
  ): Promise<Video> {
    if (!PUBLIC_ID_PATTERN.test(publicId)) {
      throw new VideoNotFoundException();
    }
    const video = await this.videos
      .createQueryBuilder('video')
      .innerJoin(Channel, 'channel', 'channel.id = video.channel_id')
      .where('video.public_id = :publicId', { publicId })
      .andWhere('channel.user_id = :userId', { userId })
      .getOne();
    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }
}

import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Video } from './entities/video.entity';
import { VideoAccessPolicy } from './video-access.policy';
import { VideoNotFoundException } from './video.exceptions';

describe('VideoAccessPolicy', () => {
  let policy: VideoAccessPolicy;
  const queryBuilder = {
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getOne: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        VideoAccessPolicy,
        {
          provide: getRepositoryToken(Video),
          useValue: { createQueryBuilder: jest.fn(() => queryBuilder) },
        },
      ],
    }).compile();
    policy = moduleRef.get(VideoAccessPolicy);
  });

  it('should return the video owned by the user', async () => {
    const video = { id: 'uuid', public_id: 'Abc123XYZ09' } as Video;
    queryBuilder.getOne.mockResolvedValue(video);

    await expect(
      policy.findOwnedVideoOrThrow('Abc123XYZ09', 'user-1'),
    ).resolves.toBe(video);
    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      'channel.user_id = :userId',
      { userId: 'user-1' },
    );
  });

  it('should answer VIDEO_NOT_FOUND for another channel or an unknown id', async () => {
    queryBuilder.getOne.mockResolvedValue(null);

    await expect(
      policy.findOwnedVideoOrThrow('Abc123XYZ09', 'intruder'),
    ).rejects.toBeInstanceOf(VideoNotFoundException);
  });

  it.each(['short', 'has-dash-1', 'Abc123XYZ09extra', ''])(
    'should answer VIDEO_NOT_FOUND for the malformed id %j without querying',
    async (publicId) => {
      await expect(
        policy.findOwnedVideoOrThrow(publicId, 'user-1'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      expect(queryBuilder.getOne).not.toHaveBeenCalled();
    },
  );
});

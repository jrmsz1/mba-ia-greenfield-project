import { Test } from '@nestjs/testing';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { createTestTypeOrmModule } from '../test/create-test-data-source';
import { Channel } from '../channels/entities/channel.entity';
import { User } from './entities/user.entity';
import { UsersModule } from './users.module';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken];

describe('UsersModule', () => {
  it('should compile successfully', async () => {
    const module = await Test.createTestingModule({
      imports: [createTestTypeOrmModule(ALL_ENTITIES), UsersModule],
    }).compile();

    expect(module).toBeDefined();
    await module.close();
  }, 30000);
});

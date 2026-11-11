import { Test } from '@nestjs/testing';
import { DataSource, QueryFailedError } from 'typeorm';
import { ChannelsService } from './channels.service';
import { Channel } from './entities/channel.entity';

interface ManagerMock {
  findOne: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
}

function makeManager(overrides: Partial<ManagerMock> = {}): ManagerMock {
  return {
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    ...overrides,
  };
}

function makeChannel(nickname: string): Channel {
  const c = new Channel();
  c.id = 'uuid';
  c.nickname = nickname;
  c.name = nickname;
  c.user_id = 'user-id';
  c.description = null;
  c.created_at = new Date();
  c.updated_at = new Date();
  return c;
}

// Built like the real thing: TypeORM copies the driver error's own properties
// (code, detail, ...) onto the QueryFailedError.
function makeQueryFailedError(
  fields: { code?: unknown; detail?: unknown } = {},
): QueryFailedError {
  const driverError = Object.assign(new Error('insert failed'), fields);
  return new QueryFailedError('INSERT', [], driverError);
}

function makeUniqueError(): QueryFailedError {
  return makeQueryFailedError({
    code: '23505',
    detail: 'Key (nickname)=(abc) already exists.',
  });
}

async function makeService(manager: ManagerMock): Promise<ChannelsService> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      ChannelsService,
      {
        provide: DataSource,
        useValue: {
          transaction: jest.fn((cb: (m: ManagerMock) => Promise<Channel>) =>
            cb(manager),
          ),
        },
      },
    ],
  }).compile();
  return moduleRef.get(ChannelsService);
}

describe('ChannelsService', () => {
  describe('createChannel', () => {
    it('derives nickname from email prefix and saves when no collision', async () => {
      const channel = makeChannel('test');
      const manager = makeManager({
        findOne: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockReturnValue(channel),
        save: jest.fn().mockResolvedValue(channel),
      });
      const service = await makeService(manager);

      const result = await service.createChannel('user-id', 'test@example.com');

      expect(manager.findOne).toHaveBeenCalledWith(Channel, {
        where: { nickname: 'test' },
      });
      expect(manager.save).toHaveBeenCalledTimes(1);
      expect(result.nickname).toBe('test');
    });

    it('retries with suffix when pre-check finds existing nickname', async () => {
      const colliding = makeChannel('john');
      const resolved = makeChannel('john_abc');
      const manager = makeManager({
        findOne: jest
          .fn()
          .mockResolvedValueOnce(colliding)
          .mockResolvedValueOnce(null),
        create: jest.fn().mockReturnValue(resolved),
        save: jest.fn().mockResolvedValue(resolved),
      });
      const service = await makeService(manager);

      const result = await service.createChannel('user-id', 'john@example.com');

      expect(manager.findOne).toHaveBeenCalledTimes(2);
      expect(manager.save).toHaveBeenCalledTimes(1);
      expect(result.nickname).toMatch(/^john_[a-z0-9]{3}$/);
    });

    it('retries with suffix on concurrent unique constraint violation', async () => {
      const resolved = makeChannel('alice_abc');
      const manager = makeManager({
        findOne: jest
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(null),
        create: jest.fn().mockReturnValue(resolved),
        save: jest
          .fn()
          .mockRejectedValueOnce(makeUniqueError())
          .mockResolvedValueOnce(resolved),
      });
      const service = await makeService(manager);

      const result = await service.createChannel(
        'user-id',
        'alice@example.com',
      );

      expect(manager.save).toHaveBeenCalledTimes(2);
      expect(result.nickname).toMatch(/^alice/);
    });

    it('creates the retried channel with a new suffixed nickname', async () => {
      const resolved = makeChannel('alice_abc');
      const created: string[] = [];
      const manager = makeManager({
        findOne: jest.fn().mockResolvedValue(null),
        create: jest.fn((_entity: unknown, data: { nickname: string }) => {
          created.push(data.nickname);
          return resolved;
        }),
        save: jest
          .fn()
          .mockRejectedValueOnce(makeUniqueError())
          .mockResolvedValueOnce(resolved),
      });
      const service = await makeService(manager);

      await service.createChannel('user-id', 'alice@example.com');

      expect(created[0]).toBe('alice');
      expect(created[1]).toMatch(/^alice_[a-z0-9]{3}$/);
    });

    it('throws after exhausting max retries', async () => {
      const existing = makeChannel('bob');
      const manager = makeManager({
        findOne: jest.fn().mockResolvedValue(existing),
        create: jest.fn(),
        save: jest.fn(),
      });
      const service = await makeService(manager);

      await expect(
        service.createChannel('user-id', 'bob@example.com'),
      ).rejects.toThrow(
        'Nickname conflict could not be resolved after max retries',
      );
    });

    it('throws after exhausting max retries on repeated unique violations', async () => {
      const manager = makeManager({
        findOne: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockReturnValue(makeChannel('dave')),
        save: jest.fn().mockRejectedValue(makeUniqueError()),
      });
      const service = await makeService(manager);

      await expect(
        service.createChannel('user-id', 'dave@example.com'),
      ).rejects.toThrow(
        'Nickname conflict could not be resolved after max retries',
      );
      expect(manager.save).toHaveBeenCalledTimes(6);
    });

    it('re-throws non-unique-constraint errors immediately', async () => {
      const unexpectedError = new Error('Connection lost');
      const channel = makeChannel('carol');
      const manager = makeManager({
        findOne: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockReturnValue(channel),
        save: jest.fn().mockRejectedValue(unexpectedError),
      });
      const service = await makeService(manager);

      await expect(
        service.createChannel('user-id', 'carol@example.com'),
      ).rejects.toThrow('Connection lost');
      expect(manager.save).toHaveBeenCalledTimes(1);
    });

    describe('errors that must not be retried', () => {
      async function expectRejectedWithoutRetry(error: unknown): Promise<void> {
        const manager = makeManager({
          findOne: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockReturnValue(makeChannel('erin')),
          save: jest.fn().mockRejectedValue(error),
        });
        const service = await makeService(manager);

        await expect(
          service.createChannel('user-id', 'erin@example.com'),
        ).rejects.toBe(error);
        expect(manager.save).toHaveBeenCalledTimes(1);
      }

      it('re-throws a unique violation on another column', async () => {
        await expectRejectedWithoutRetry(
          makeQueryFailedError({
            code: '23505',
            detail: 'Key (user_id)=(abc) already exists.',
          }),
        );
      });

      it.each(['23503', '40001', '25P02'])(
        're-throws PostgreSQL error code %s even when the detail mentions nickname',
        async (code) => {
          await expectRejectedWithoutRetry(
            makeQueryFailedError({
              code,
              detail: 'Key (nickname)=(abc) already exists.',
            }),
          );
        },
      );

      it('re-throws a QueryFailedError without code and detail', async () => {
        await expectRejectedWithoutRetry(makeQueryFailedError());
      });

      it.each([[undefined], [null], [123], [['nickname']]])(
        're-throws a unique violation whose detail is %p',
        async (detail) => {
          await expectRejectedWithoutRetry(
            makeQueryFailedError({ code: '23505', detail }),
          );
        },
      );

      it('re-throws a plain object that only looks like a unique violation', async () => {
        await expectRejectedWithoutRetry({
          code: '23505',
          detail: 'Key (nickname)=(abc) already exists.',
        });
      });

      it.each([['boom'], [null], [undefined]])(
        're-throws the non-Error value %p unchanged',
        async (value) => {
          await expectRejectedWithoutRetry(value);
        },
      );
    });
  });
});

import { getMailpitMessage, getMailpitMessages } from './mailpit';

const address = { Name: '', Address: 'user@example.com' };
const summary = {
  ID: 'abc123',
  Subject: 'Hello',
  From: address,
  To: [address],
};

describe('mailpit helpers', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  describe('getMailpitMessages', () => {
    it('should return the message summaries', async () => {
      fetchSpy.mockResolvedValueOnce(Response.json({ messages: [summary] }));

      await expect(getMailpitMessages()).resolves.toEqual([summary]);
    });

    it.each([[null], [undefined]])(
      'should return an empty list when messages is %p',
      async (messages) => {
        fetchSpy.mockResolvedValueOnce(Response.json({ messages }));

        await expect(getMailpitMessages()).resolves.toEqual([]);
      },
    );

    it('should reject a summary without the fields the tests read', async () => {
      fetchSpy.mockResolvedValueOnce(
        Response.json({ messages: [{ ID: 'abc123' }] }),
      );

      await expect(getMailpitMessages()).rejects.toThrow(
        'Unexpected response from Mailpit GET /api/v1/messages',
      );
    });

    it('should reject a body that is not an object', async () => {
      fetchSpy.mockResolvedValueOnce(Response.json('nope'));

      await expect(getMailpitMessages()).rejects.toThrow(
        'Unexpected response from Mailpit GET /api/v1/messages',
      );
    });
  });

  describe('getMailpitMessage', () => {
    it('should return the message with its HTML body', async () => {
      const message = { ...summary, HTML: '<p>hi</p>' };
      fetchSpy.mockResolvedValueOnce(Response.json(message));

      await expect(getMailpitMessage('abc123')).resolves.toEqual(message);
    });

    it('should reject a message without an HTML body', async () => {
      fetchSpy.mockResolvedValueOnce(Response.json(summary));

      await expect(getMailpitMessage('abc123')).rejects.toThrow(
        'Unexpected response from Mailpit GET /api/v1/message/abc123',
      );
    });
  });
});

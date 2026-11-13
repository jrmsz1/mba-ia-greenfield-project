const mailpitUrl = `http://${process.env.MAIL_HOST ?? 'mailpit'}:8025`;

/**
 * Subset of the Mailpit REST API (v1) that the tests read. Field names follow
 * the Mailpit schema (`MessageSummary` / `Message`), hence the PascalCase.
 */
export interface MailpitAddress {
  Name: string;
  Address: string;
}

export interface MailpitMessageSummary {
  ID: string;
  Subject: string;
  From: MailpitAddress;
  To: MailpitAddress[];
}

export interface MailpitMessage extends MailpitMessageSummary {
  HTML: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isAddress(value: unknown): value is MailpitAddress {
  return (
    isRecord(value) &&
    typeof value.Name === 'string' &&
    typeof value.Address === 'string'
  );
}

function isMessageSummary(value: unknown): value is MailpitMessageSummary {
  return (
    isRecord(value) &&
    typeof value.ID === 'string' &&
    typeof value.Subject === 'string' &&
    isAddress(value.From) &&
    Array.isArray(value.To) &&
    value.To.every(isAddress)
  );
}

function isMessage(value: unknown): value is MailpitMessage {
  return (
    isRecord(value) && isMessageSummary(value) && typeof value.HTML === 'string'
  );
}

export async function getMailpitMessages(): Promise<MailpitMessageSummary[]> {
  const res = await fetch(`${mailpitUrl}/api/v1/messages`);
  const data: unknown = await res.json();
  const messages: unknown = isRecord(data) ? (data.messages ?? []) : undefined;
  if (!Array.isArray(messages) || !messages.every(isMessageSummary)) {
    throw new Error('Unexpected response from Mailpit GET /api/v1/messages');
  }
  return messages;
}

export async function getMailpitMessage(id: string): Promise<MailpitMessage> {
  const res = await fetch(`${mailpitUrl}/api/v1/message/${id}`);
  const data: unknown = await res.json();
  if (!isMessage(data)) {
    throw new Error(
      `Unexpected response from Mailpit GET /api/v1/message/${id}`,
    );
  }
  return data;
}

export async function clearMailpitMessages(): Promise<void> {
  await fetch(`${mailpitUrl}/api/v1/messages`, { method: 'DELETE' });
}

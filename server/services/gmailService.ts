import { google, gmail_v1 } from 'googleapis';

// ─── Types ───────────────────────────────────────────────────────────────────
export interface GmailMessage {
  id: string;
  threadId: string;
  subject: string | null;
  from: { name: string | null; email: string } | null;
  to: Array<{ name: string | null; email: string }>;
  cc: Array<{ name: string | null; email: string }>;
  date: string | null;
  snippet: string | null;
  body: { plain: string | null; html: string | null };
  isUnread: boolean;
  labelIds: string[];
  attachments: Array<{ filename: string; mimeType: string; size: number; attachmentId: string }>;
}

export interface GmailMessageList {
  messages: GmailMessage[];
  nextPageToken: string | null;
  resultSizeEstimate: number;
}

export interface GmailLabel {
  id: string;
  name: string;
  type: string | null;
  messagesTotal: number | null;
  messagesUnread: number | null;
  color: { textColor: string | null; backgroundColor: string | null } | null;
}

export interface GmailThread {
  id: string;
  messages: GmailMessage[];
}

export interface SendEmailInput {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  inReplyTo?: string;
  threadId?: string;
}

// ─── Gmail Client Factory ────────────────────────────────────────────────────
function createGmailClient(accessToken: string, refreshToken?: string | null): gmail_v1.Gmail {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_GMAIL_REDIRECT_URI
  );

  oauth2Client.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken ?? undefined,
  });

  return google.gmail({ version: 'v1', auth: oauth2Client });
}

// ─── Parse Email Address ─────────────────────────────────────────────────────
function parseEmailAddress(header: string): { name: string | null; email: string } {
  const match = header.match(/^(.+?)\s*<(.+?)>$/);
  if (match) {
    return { name: match[1].replace(/^"|"$/g, '').trim(), email: match[2] };
  }
  return { name: null, email: header.trim() };
}

function parseEmailAddresses(header: string | null): Array<{ name: string | null; email: string }> {
  if (!header) return [];
  return header.split(',').map((addr) => parseEmailAddress(addr.trim()));
}

// ─── Get Header Value ────────────────────────────────────────────────────────
function getHeader(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string | null {
  if (!headers) return null;
  const header = headers.find((h) => h.name?.toLowerCase() === name.toLowerCase());
  return header?.value ?? null;
}

// ─── Extract Body ────────────────────────────────────────────────────────────
function extractBody(payload: gmail_v1.Schema$MessagePart | undefined): { plain: string | null; html: string | null } {
  if (!payload) return { plain: null, html: null };

  let plain: string | null = null;
  let html: string | null = null;

  function walk(part: gmail_v1.Schema$MessagePart) {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      plain = Buffer.from(part.body.data, 'base64url').toString('utf-8');
    }
    if (part.mimeType === 'text/html' && part.body?.data) {
      html = Buffer.from(part.body.data, 'base64url').toString('utf-8');
    }
    if (part.parts) {
      part.parts.forEach(walk);
    }
  }

  walk(payload);
  return { plain, html };
}

// ─── Extract Attachments ─────────────────────────────────────────────────────
function extractAttachments(payload: gmail_v1.Schema$MessagePart | undefined): Array<{ filename: string; mimeType: string; size: number; attachmentId: string }> {
  const attachments: Array<{ filename: string; mimeType: string; size: number; attachmentId: string }> = [];

  function walk(part: gmail_v1.Schema$MessagePart) {
    if (part.filename && part.body?.attachmentId) {
      attachments.push({
        filename: part.filename,
        mimeType: part.mimeType || 'application/octet-stream',
        size: part.body.size || 0,
        attachmentId: part.body.attachmentId,
      });
    }
    if (part.parts) {
      part.parts.forEach(walk);
    }
  }

  if (payload) walk(payload);
  return attachments;
}

// ─── Map Gmail Message ───────────────────────────────────────────────────────
function mapMessage(msg: gmail_v1.Schema$Message, includeBody: boolean = false): GmailMessage {
  const headers = msg.payload?.headers;
  const fromHeader = getHeader(headers, 'From');
  const body = includeBody ? extractBody(msg.payload) : { plain: null, html: null };

  return {
    id: msg.id!,
    threadId: msg.threadId!,
    subject: getHeader(headers, 'Subject'),
    from: fromHeader ? parseEmailAddress(fromHeader) : null,
    to: parseEmailAddresses(getHeader(headers, 'To')),
    cc: parseEmailAddresses(getHeader(headers, 'Cc')),
    date: getHeader(headers, 'Date'),
    snippet: msg.snippet ?? null,
    body,
    isUnread: (msg.labelIds || []).includes('UNREAD'),
    labelIds: msg.labelIds || [],
    attachments: includeBody ? extractAttachments(msg.payload) : [],
  };
}

// ─── List Messages ───────────────────────────────────────────────────────────
export async function listMessages(
  accessToken: string,
  options?: {
    refreshToken?: string | null;
    pageSize?: number;
    pageToken?: string;
    query?: string;
    labelIds?: string[];
  }
): Promise<GmailMessageList> {
  const gmail = createGmailClient(accessToken, options?.refreshToken);

  const response = await gmail.users.messages.list({
    userId: 'me',
    maxResults: options?.pageSize || 20,
    pageToken: options?.pageToken || undefined,
    q: options?.query || undefined,
    labelIds: options?.labelIds || ['INBOX'],
  });

  const messageIds = response.data.messages || [];
  const messages: GmailMessage[] = [];

  // Fetch each message with metadata (not full body for list view)
  for (const msgRef of messageIds) {
    try {
      const msgResponse = await gmail.users.messages.get({
        userId: 'me',
        id: msgRef.id!,
        format: 'metadata',
        metadataHeaders: ['From', 'To', 'Subject', 'Date', 'Cc'],
      });
      messages.push(mapMessage(msgResponse.data, false));
    } catch {
      // Skip messages that fail to fetch
    }
  }

  return {
    messages,
    nextPageToken: response.data.nextPageToken ?? null,
    resultSizeEstimate: response.data.resultSizeEstimate ?? 0,
  };
}

// ─── Get Message ─────────────────────────────────────────────────────────────
export async function getMessage(
  accessToken: string,
  messageId: string,
  refreshToken?: string | null
): Promise<GmailMessage> {
  const gmail = createGmailClient(accessToken, refreshToken);

  const response = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  });

  return mapMessage(response.data, true);
}

// ─── Send Email ──────────────────────────────────────────────────────────────
export async function sendEmail(
  accessToken: string,
  input: SendEmailInput,
  refreshToken?: string | null
): Promise<GmailMessage> {
  const gmail = createGmailClient(accessToken, refreshToken);

  // Build RFC 2822 email
  const headers: string[] = [
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
  ];

  if (input.cc) headers.push(`Cc: ${input.cc}`);
  if (input.bcc) headers.push(`Bcc: ${input.bcc}`);
  if (input.inReplyTo) {
    headers.push(`In-Reply-To: ${input.inReplyTo}`);
    headers.push(`References: ${input.inReplyTo}`);
  }

  const raw = Buffer.from(
    headers.join('\r\n') + '\r\n\r\n' + input.body
  ).toString('base64url');

  const response = await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw,
      threadId: input.threadId || undefined,
    },
  });

  // Fetch the sent message to return full data
  const sentMsg = await gmail.users.messages.get({
    userId: 'me',
    id: response.data.id!,
    format: 'full',
  });

  return mapMessage(sentMsg.data, true);
}

// ─── List Labels ─────────────────────────────────────────────────────────────
export async function listLabels(
  accessToken: string,
  refreshToken?: string | null
): Promise<GmailLabel[]> {
  const gmail = createGmailClient(accessToken, refreshToken);

  const response = await gmail.users.labels.list({ userId: 'me' });

  return (response.data.labels || []).map((l) => ({
    id: l.id!,
    name: l.name!,
    type: l.type ?? null,
    messagesTotal: l.messagesTotal ?? null,
    messagesUnread: l.messagesUnread ?? null,
    color: l.color
      ? { textColor: l.color.textColor ?? null, backgroundColor: l.color.backgroundColor ?? null }
      : null,
  }));
}

// ─── Mark as Read ────────────────────────────────────────────────────────────
export async function markAsRead(
  accessToken: string,
  messageId: string,
  refreshToken?: string | null
): Promise<void> {
  const gmail = createGmailClient(accessToken, refreshToken);

  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: {
      removeLabelIds: ['UNREAD'],
    },
  });
}

// ─── Trash Message ───────────────────────────────────────────────────────────
export async function trashMessage(
  accessToken: string,
  messageId: string,
  refreshToken?: string | null
): Promise<void> {
  const gmail = createGmailClient(accessToken, refreshToken);

  await gmail.users.messages.trash({
    userId: 'me',
    id: messageId,
  });
}

// ─── Get Thread ──────────────────────────────────────────────────────────────
export async function getThread(
  accessToken: string,
  threadId: string,
  refreshToken?: string | null
): Promise<GmailThread> {
  const gmail = createGmailClient(accessToken, refreshToken);

  const response = await gmail.users.threads.get({
    userId: 'me',
    id: threadId,
    format: 'full',
  });

  return {
    id: response.data.id!,
    messages: (response.data.messages || []).map((msg) => mapMessage(msg, true)),
  };
}

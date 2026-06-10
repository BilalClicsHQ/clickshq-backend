import { eq, and } from 'drizzle-orm';
import { db } from '../db';
import { userIntegrations } from '@shared/schema';
import { encryptToken, decryptToken } from './slackService';

// ─── Types ───────────────────────────────────────────────────────────────────
export type Provider = 'ms_teams' | 'outlook_calendar' | 'onedrive' | 'outlook_email' | 'google_drive' | 'google_calendar' | 'gmail' | 'dropbox' | 'github' | 'figma' | 'jira' | 'salesforce';

export interface TokenData {
  accessToken: string;
  refreshToken?: string | null;
  tokenExpiry: Date;
  scope?: string | null;
  providerUserId?: string | null;
  providerEmail?: string | null;
  metadata?: string | null;
}

export interface DecryptedToken extends TokenData {
  id: string;
  userId: string;
  provider: Provider;
  connectedAt: Date | null;
  updatedAt: Date | null;
}

// ─── Error Codes ─────────────────────────────────────────────────────────────
export class TokenError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryable: boolean = false
  ) {
    super(message);
    this.name = 'TokenError';
  }
}

// ─── Get Token ───────────────────────────────────────────────────────────────
// Fetches + decrypts a user's token for a given provider.
// Returns null if user is not connected.
export async function getToken(userId: string, provider: Provider): Promise<DecryptedToken | null> {
  const [row] = await db
    .select()
    .from(userIntegrations)
    .where(and(eq(userIntegrations.userId, userId), eq(userIntegrations.provider, provider)))
    .limit(1);

  if (!row) return null;

  return {
    id: row.id,
    userId: row.userId,
    provider: row.provider as Provider,
    accessToken: decryptToken(row.accessToken),
    refreshToken: row.refreshToken ? decryptToken(row.refreshToken) : null,
    tokenExpiry: row.tokenExpiry,
    scope: row.scope,
    providerUserId: row.providerUserId,
    providerEmail: row.providerEmail,
    metadata: row.metadata,
    connectedAt: row.connectedAt,
    updatedAt: row.updatedAt,
  };
}

// ─── Save Token (upsert) ────────────────────────────────────────────────────
// Encrypts tokens and inserts or updates the row for user+provider.
export async function saveToken(userId: string, provider: Provider, data: TokenData): Promise<void> {
  const encrypted = {
    accessToken: encryptToken(data.accessToken),
    refreshToken: data.refreshToken ? encryptToken(data.refreshToken) : null,
    tokenExpiry: data.tokenExpiry,
    scope: data.scope ?? null,
    providerUserId: data.providerUserId ?? null,
    providerEmail: data.providerEmail ?? null,
    metadata: data.metadata ?? null,
  };

  // Check if row exists
  const [existing] = await db
    .select({ id: userIntegrations.id })
    .from(userIntegrations)
    .where(and(eq(userIntegrations.userId, userId), eq(userIntegrations.provider, provider)))
    .limit(1);

  if (existing) {
    await db
      .update(userIntegrations)
      .set({ ...encrypted, updatedAt: new Date() })
      .where(eq(userIntegrations.id, existing.id));
  } else {
    await db.insert(userIntegrations).values({
      userId,
      provider,
      ...encrypted,
    });
  }
}

// ─── Delete Token ────────────────────────────────────────────────────────────
// Removes a user's integration (disconnect).
export async function deleteToken(userId: string, provider: Provider): Promise<boolean> {
  const result = await db
    .delete(userIntegrations)
    .where(and(eq(userIntegrations.userId, userId), eq(userIntegrations.provider, provider)))
    .returning({ id: userIntegrations.id });

  return result.length > 0;
}

// ─── Check Connection ────────────────────────────────────────────────────────
// Quick check if user is connected to a provider (no decryption).
export async function isConnected(userId: string, provider: Provider): Promise<boolean> {
  const [row] = await db
    .select({ id: userIntegrations.id })
    .from(userIntegrations)
    .where(and(eq(userIntegrations.userId, userId), eq(userIntegrations.provider, provider)))
    .limit(1);

  return !!row;
}

// ─── Token Expiry Check ─────────────────────────────────────────────────────
// Returns true if access token is expired or expires within bufferMs.
export function isTokenExpired(expiry: Date, bufferMs: number = 5 * 60 * 1000): boolean {
  return new Date().getTime() >= expiry.getTime() - bufferMs;
}

// ─── Refresh MS Teams Token ──────────────────────────────────────────────────
// Uses @azure/msal-node to silently refresh. Called by middleware.
export async function refreshTeamsToken(userId: string): Promise<DecryptedToken> {
  const token = await getToken(userId, 'ms_teams');
  if (!token) {
    throw new TokenError('USER_NOT_CONNECTED', 'User is not connected to MS Teams', false);
  }
  if (!token.refreshToken) {
    throw new TokenError('REFRESH_FAILED', 'No refresh token available for MS Teams — user must reconnect', false);
  }

  // Lazy import to avoid loading msal-node when not needed
  const { ConfidentialClientApplication } = await import('@azure/msal-node');

  const msalConfig = {
    auth: {
      clientId: process.env.AZURE_CLIENT_ID!,
      clientSecret: process.env.AZURE_CLIENT_SECRET!,
      authority: `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID || 'common'}`,
    },
  };

  const cca = new ConfidentialClientApplication(msalConfig);

  try {
    const result = await cca.acquireTokenByRefreshToken({
      refreshToken: token.refreshToken,
      scopes: (process.env.AZURE_SCOPES || '').split(' ').filter(Boolean),
    });

    if (!result) {
      throw new TokenError('REFRESH_FAILED', 'MS Teams token refresh returned no result', false);
    }

    const newTokenData: TokenData = {
      accessToken: result.accessToken,
      refreshToken: token.refreshToken, // MSAL doesn't always return new refresh token
      tokenExpiry: result.expiresOn || new Date(Date.now() + 3600 * 1000),
      scope: result.scopes?.join(' ') ?? token.scope,
      providerUserId: token.providerUserId,
      providerEmail: token.providerEmail,
      metadata: token.metadata,
    };

    await saveToken(userId, 'ms_teams', newTokenData);
    return { ...newTokenData, id: token.id, userId, provider: 'ms_teams', connectedAt: token.connectedAt, updatedAt: new Date() };
  } catch (err: any) {
    if (err instanceof TokenError) throw err;
    throw new TokenError('REFRESH_FAILED', `MS Teams refresh failed: ${err.message}`, false);
  }
}

// ─── Refresh Outlook Calendar Token ─────────────────────────────────────────
// Uses @azure/msal-node to silently refresh. Called by middleware.
export async function refreshOutlookCalendarToken(userId: string): Promise<DecryptedToken> {
  return refreshMicrosoftToken(userId, 'outlook_calendar');
}

// ─── Refresh OneDrive Token ─────────────────────────────────────────────────
export async function refreshOneDriveToken(userId: string): Promise<DecryptedToken> {
  return refreshMicrosoftToken(userId, 'onedrive');
}

// ─── Refresh Outlook Email Token ────────────────────────────────────────────
export async function refreshOutlookEmailToken(userId: string): Promise<DecryptedToken> {
  return refreshMicrosoftToken(userId, 'outlook_email');
}

// ─── Shared Microsoft Token Refresh ─────────────────────────────────────────
// All Microsoft providers use the same MSAL refresh flow.
async function refreshMicrosoftToken(userId: string, provider: Provider): Promise<DecryptedToken> {
  const token = await getToken(userId, provider);
  if (!token) {
    throw new TokenError('USER_NOT_CONNECTED', `User is not connected to ${provider}`, false);
  }
  if (!token.refreshToken) {
    throw new TokenError('REFRESH_FAILED', `No refresh token available for ${provider} — user must reconnect`, false);
  }

  const { ConfidentialClientApplication } = await import('@azure/msal-node');

  const msalConfig = {
    auth: {
      clientId: process.env.AZURE_CLIENT_ID!,
      clientSecret: process.env.AZURE_CLIENT_SECRET!,
      authority: `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID || 'common'}`,
    },
  };

  const cca = new ConfidentialClientApplication(msalConfig);

  try {
    const result = await cca.acquireTokenByRefreshToken({
      refreshToken: token.refreshToken,
      scopes: (process.env.AZURE_SCOPES || '').split(' ').filter(Boolean),
    });

    if (!result) {
      throw new TokenError('REFRESH_FAILED', `${provider} token refresh returned no result`, false);
    }

    const newTokenData: TokenData = {
      accessToken: result.accessToken,
      refreshToken: token.refreshToken,
      tokenExpiry: result.expiresOn || new Date(Date.now() + 3600 * 1000),
      scope: result.scopes?.join(' ') ?? token.scope,
      providerUserId: token.providerUserId,
      providerEmail: token.providerEmail,
      metadata: token.metadata,
    };

    await saveToken(userId, provider, newTokenData);
    return { ...newTokenData, id: token.id, userId, provider, connectedAt: token.connectedAt, updatedAt: new Date() };
  } catch (err: any) {
    if (err instanceof TokenError) throw err;
    throw new TokenError('REFRESH_FAILED', `${provider} refresh failed: ${err.message}`, false);
  }
}

// ─── Refresh Google Drive Token ──────────────────────────────────────────────
// Uses googleapis OAuth2Client auto-refresh. Called by middleware.
export async function refreshDriveToken(userId: string): Promise<DecryptedToken> {
  const token = await getToken(userId, 'google_drive');
  if (!token) {
    throw new TokenError('USER_NOT_CONNECTED', 'User is not connected to Google Drive', false);
  }
  if (!token.refreshToken) {
    throw new TokenError('REFRESH_FAILED', 'No refresh token available for Google Drive — user must reconnect', false);
  }

  const { google } = await import('googleapis');

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  oauth2Client.setCredentials({ refresh_token: token.refreshToken });

  try {
    const { credentials } = await oauth2Client.refreshAccessToken();

    if (!credentials.access_token) {
      throw new TokenError('REFRESH_FAILED', 'Google Drive refresh returned no access token', false);
    }

    const newTokenData: TokenData = {
      accessToken: credentials.access_token,
      refreshToken: credentials.refresh_token ?? token.refreshToken,
      tokenExpiry: credentials.expiry_date
        ? new Date(credentials.expiry_date)
        : new Date(Date.now() + 3600 * 1000),
      scope: credentials.scope ?? token.scope,
      providerUserId: token.providerUserId,
      providerEmail: token.providerEmail,
      metadata: token.metadata,
    };

    await saveToken(userId, 'google_drive', newTokenData);
    return { ...newTokenData, id: token.id, userId, provider: 'google_drive', connectedAt: token.connectedAt, updatedAt: new Date() };
  } catch (err: any) {
    if (err instanceof TokenError) throw err;
    // Google returns 'invalid_grant' when refresh token is revoked/expired
    if (err.message?.includes('invalid_grant')) {
      throw new TokenError('REFRESH_FAILED', 'Google Drive refresh token revoked or expired — user must reconnect', false);
    }
    throw new TokenError('REFRESH_FAILED', `Google Drive refresh failed: ${err.message}`, false);
  }
}

// ─── Refresh Dropbox Token ──────────────────────────────────────────────────
// Dropbox tokens expire in 4 hours; use refresh_token grant to renew.
// Docs: https://developers.dropbox.com/oauth-guide#refresh-tokens
export async function refreshDropboxToken(userId: string): Promise<DecryptedToken> {
  const token = await getToken(userId, 'dropbox');
  if (!token) {
    throw new TokenError('USER_NOT_CONNECTED', 'User is not connected to Dropbox', false);
  }
  if (!token.refreshToken) {
    throw new TokenError(
      'REFRESH_FAILED',
      'No refresh token for Dropbox — user must reconnect (legacy long-lived tokens are deprecated)',
      false,
    );
  }

  const clientId = process.env.DROPBOX_CLIENT_ID;
  const clientSecret = process.env.DROPBOX_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new TokenError('REFRESH_FAILED', 'Dropbox credentials not configured on server', false);
  }

  try {
    const res = await fetch('https://api.dropbox.com/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: token.refreshToken,
      }),
    });

    const data: any = await res.json();
    if (!res.ok || !data?.access_token) {
      throw new TokenError(
        'REFRESH_FAILED',
        `Dropbox refresh failed: ${data?.error_description ?? data?.error ?? res.status}`,
        false,
      );
    }

    const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 14400;
    const newTokenData: TokenData = {
      accessToken: data.access_token,
      // Dropbox refresh_token does NOT rotate on refresh — keep the original
      refreshToken: token.refreshToken,
      tokenExpiry: new Date(Date.now() + expiresIn * 1000),
      scope: data.scope ?? token.scope,
      providerUserId: token.providerUserId,
      providerEmail: token.providerEmail,
      metadata: token.metadata,
    };

    await saveToken(userId, 'dropbox', newTokenData);
    return {
      ...newTokenData,
      id: token.id,
      userId,
      provider: 'dropbox',
      connectedAt: token.connectedAt,
      updatedAt: new Date(),
    };
  } catch (err: any) {
    if (err instanceof TokenError) throw err;
    throw new TokenError('REFRESH_FAILED', `Dropbox refresh failed: ${err.message}`, false);
  }
}

// ─── Refresh Google Calendar Token ──────────────────────────────────────────
// Uses googleapis OAuth2Client auto-refresh. Called by middleware.
export async function refreshCalendarToken(userId: string): Promise<DecryptedToken> {
  const token = await getToken(userId, 'google_calendar');
  if (!token) {
    throw new TokenError('USER_NOT_CONNECTED', 'User is not connected to Google Calendar', false);
  }
  if (!token.refreshToken) {
    throw new TokenError('REFRESH_FAILED', 'No refresh token available for Google Calendar — user must reconnect', false);
  }

  const { google } = await import('googleapis');

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_CALENDAR_REDIRECT_URI
  );

  oauth2Client.setCredentials({ refresh_token: token.refreshToken });

  try {
    const { credentials } = await oauth2Client.refreshAccessToken();

    if (!credentials.access_token) {
      throw new TokenError('REFRESH_FAILED', 'Google Calendar refresh returned no access token', false);
    }

    const newTokenData: TokenData = {
      accessToken: credentials.access_token,
      refreshToken: credentials.refresh_token ?? token.refreshToken,
      tokenExpiry: credentials.expiry_date
        ? new Date(credentials.expiry_date)
        : new Date(Date.now() + 3600 * 1000),
      scope: credentials.scope ?? token.scope,
      providerUserId: token.providerUserId,
      providerEmail: token.providerEmail,
      metadata: token.metadata,
    };

    await saveToken(userId, 'google_calendar', newTokenData);
    return { ...newTokenData, id: token.id, userId, provider: 'google_calendar', connectedAt: token.connectedAt, updatedAt: new Date() };
  } catch (err: any) {
    if (err instanceof TokenError) throw err;
    if (err.message?.includes('invalid_grant')) {
      throw new TokenError('REFRESH_FAILED', 'Google Calendar refresh token revoked or expired — user must reconnect', false);
    }
    throw new TokenError('REFRESH_FAILED', `Google Calendar refresh failed: ${err.message}`, false);
  }
}

// ─── Refresh Gmail Token ─────────────────────────────────────────────────────
// Uses googleapis OAuth2Client auto-refresh. Called by middleware.
export async function refreshGmailToken(userId: string): Promise<DecryptedToken> {
  const token = await getToken(userId, 'gmail');
  if (!token) {
    throw new TokenError('USER_NOT_CONNECTED', 'User is not connected to Gmail', false);
  }
  if (!token.refreshToken) {
    throw new TokenError('REFRESH_FAILED', 'No refresh token available for Gmail — user must reconnect', false);
  }

  const { google } = await import('googleapis');

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_GMAIL_REDIRECT_URI
  );

  oauth2Client.setCredentials({ refresh_token: token.refreshToken });

  try {
    const { credentials } = await oauth2Client.refreshAccessToken();

    if (!credentials.access_token) {
      throw new TokenError('REFRESH_FAILED', 'Gmail refresh returned no access token', false);
    }

    const newTokenData: TokenData = {
      accessToken: credentials.access_token,
      refreshToken: credentials.refresh_token ?? token.refreshToken,
      tokenExpiry: credentials.expiry_date
        ? new Date(credentials.expiry_date)
        : new Date(Date.now() + 3600 * 1000),
      scope: credentials.scope ?? token.scope,
      providerUserId: token.providerUserId,
      providerEmail: token.providerEmail,
      metadata: token.metadata,
    };

    await saveToken(userId, 'gmail', newTokenData);
    return { ...newTokenData, id: token.id, userId, provider: 'gmail', connectedAt: token.connectedAt, updatedAt: new Date() };
  } catch (err: any) {
    if (err instanceof TokenError) throw err;
    if (err.message?.includes('invalid_grant')) {
      throw new TokenError('REFRESH_FAILED', 'Gmail refresh token revoked or expired — user must reconnect', false);
    }
    throw new TokenError('REFRESH_FAILED', `Gmail refresh failed: ${err.message}`, false);
  }
}

// ─── Refresh Jira Token ─────────────────────────────────────────────────────
// Uses Atlassian OAuth 2.0 refresh flow. Called by middleware.
export async function refreshJiraToken(userId: string): Promise<DecryptedToken> {
  const token = await getToken(userId, 'jira');
  if (!token) {
    throw new TokenError('USER_NOT_CONNECTED', 'User is not connected to Jira', false);
  }
  if (!token.refreshToken) {
    throw new TokenError('REFRESH_FAILED', 'No refresh token available for Jira — user must reconnect', false);
  }

  try {
    const tokenResponse = await fetch('https://auth.atlassian.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: process.env.JIRA_CLIENT_ID!,
        client_secret: process.env.JIRA_CLIENT_SECRET!,
        refresh_token: token.refreshToken,
      }),
    });

    const tokens = await tokenResponse.json() as any;
    if (tokens.error) {
      throw new TokenError('REFRESH_FAILED', `Jira refresh failed: ${tokens.error_description || tokens.error}`, false);
    }

    const newTokenData: TokenData = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? token.refreshToken,
      tokenExpiry: tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000)
        : new Date(Date.now() + 3600 * 1000),
      scope: tokens.scope ?? token.scope,
      providerUserId: token.providerUserId,
      providerEmail: token.providerEmail,
      metadata: token.metadata,
    };

    await saveToken(userId, 'jira', newTokenData);
    return { ...newTokenData, id: token.id, userId, provider: 'jira', connectedAt: token.connectedAt, updatedAt: new Date() };
  } catch (err: any) {
    if (err instanceof TokenError) throw err;
    throw new TokenError('REFRESH_FAILED', `Jira refresh failed: ${err.message}`, false);
  }
}

// ─── Get Valid Token (auto-refresh) ──────────────────────────────────────────
// Main entry point for routes — returns a valid (non-expired) access token.
export async function getValidToken(userId: string, provider: Provider): Promise<DecryptedToken> {
  const token = await getToken(userId, provider);
  if (!token) {
    throw new TokenError('USER_NOT_CONNECTED', `User is not connected to ${provider}`, false);
  }

  // If token is still valid (with 5-min buffer), return it
  if (!isTokenExpired(token.tokenExpiry)) {
    return token;
  }

  // Token expired — refresh
  if (provider === 'ms_teams') {
    return refreshTeamsToken(userId);
  } else if (provider === 'outlook_calendar') {
    return refreshOutlookCalendarToken(userId);
  } else if (provider === 'onedrive') {
    return refreshOneDriveToken(userId);
  } else if (provider === 'outlook_email') {
    return refreshOutlookEmailToken(userId);
  } else if (provider === 'google_calendar') {
    return refreshCalendarToken(userId);
  } else if (provider === 'gmail') {
    return refreshGmailToken(userId);
  } else if (provider === 'jira') {
    return refreshJiraToken(userId);
  } else if (provider === 'dropbox') {
    return refreshDropboxToken(userId);
  } else {
    return refreshDriveToken(userId);
  }
}

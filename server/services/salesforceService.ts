import { getToken, saveToken, isTokenExpired } from './tokenService';
import type { Provider, DecryptedToken } from './tokenService';

const PROVIDER: Provider = 'salesforce';

// ─── Refresh Token ──────────────────────────────────────────────────────────
export async function refreshSalesforceToken(userId: string, token: DecryptedToken): Promise<DecryptedToken> {
  if (!token.refreshToken) {
    throw new Error('No refresh token available for Salesforce');
  }

  const loginUrl = process.env.SALESFORCE_LOGIN_URL || 'https://login.salesforce.com';
  const res = await fetch(`${loginUrl}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: token.refreshToken,
      client_id: process.env.SALESFORCE_CLIENT_ID!,
      client_secret: process.env.SALESFORCE_CLIENT_SECRET!,
    }),
  });

  const data = await res.json() as any;
  if (data.error) {
    throw new Error(data.error_description || data.error);
  }

  await saveToken(userId, PROVIDER, {
    accessToken: data.access_token,
    refreshToken: token.refreshToken, // Salesforce doesn't return a new refresh token
    tokenExpiry: new Date(Date.now() + 2 * 3600 * 1000),
    scope: token.scope,
    providerUserId: token.providerUserId,
    providerEmail: token.providerEmail,
    metadata: JSON.stringify({
      instanceUrl: data.instance_url,
      tokenType: data.token_type,
    }),
  });

  return (await getToken(userId, PROVIDER))!;
}

// ─── Get Valid Token (with auto-refresh) ────────────────────────────────────
export async function getValidSalesforceToken(userId: string): Promise<{ accessToken: string; instanceUrl: string }> {
  let token = await getToken(userId, PROVIDER);
  if (!token) {
    throw new Error('Salesforce is not connected. Please connect first.');
  }

  if (isTokenExpired(token.tokenExpiry)) {
    token = await refreshSalesforceToken(userId, token);
  }

  const metadata = token.metadata ? JSON.parse(token.metadata) : {};
  return {
    accessToken: token.accessToken,
    instanceUrl: metadata.instanceUrl || '',
  };
}

// ─── Salesforce API Helper ──────────────────────────────────────────────────
export async function salesforceApi(
  accessToken: string,
  instanceUrl: string,
  endpoint: string,
  options: RequestInit = {},
): Promise<any> {
  const apiVersion = 'v59.0';
  const url = `${instanceUrl}/services/data/${apiVersion}${endpoint}`;

  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...options.headers,
    },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => [{}]) as any;
    const message = Array.isArray(err) ? err[0]?.message : err.message;
    throw new Error(message || `Salesforce API error: ${res.status}`);
  }

  // Some endpoints return 204 with no body
  if (res.status === 204) return null;
  return res.json();
}

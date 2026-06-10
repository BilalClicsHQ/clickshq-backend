import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { requireAuth } from '../auth';
import { saveToken, deleteToken, isConnected } from '../services/tokenService';
import type { Provider } from '../services/tokenService';

const router = Router();

// ─── Signed State (stateless — works on serverless) ─────────────────────────
// Instead of in-memory Map, we sign userId+provider+timestamp into the state.
// The callback verifies the signature — no shared memory needed.
const STATE_SECRET = process.env.SESSION_SECRET || 'oauth-state-fallback-secret';

function createSignedState(userId: string, provider: Provider): string {
  const payload = JSON.stringify({ userId, provider, ts: Date.now() });
  const payloadB64 = Buffer.from(payload).toString('base64url');
  const signature = crypto.createHmac('sha256', STATE_SECRET).update(payloadB64).digest('base64url');
  return `${payloadB64}.${signature}`;
}

function verifySignedState(state: string): { userId: string; provider: Provider; ts: number } | null {
  const [payloadB64, signature] = state.split('.');
  if (!payloadB64 || !signature) return null;

  const expected = crypto.createHmac('sha256', STATE_SECRET).update(payloadB64).digest('base64url');
  if (signature !== expected) return null;

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    // Expire after 10 minutes
    if (Date.now() - payload.ts > 10 * 60 * 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// GOOGLE DRIVE — OAuth Init
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/drive/init', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    if (!user?.id) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'User not authenticated', retryable: false } });
    }

    const connected = await isConnected(user.id, 'google_drive');
    if (connected) {
      return res.status(400).json({ success: false, error: { code: 'ALREADY_CONNECTED', message: 'Google Drive is already connected. Disconnect first.', retryable: false } });
    }

    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
      return res.status(500).json({ success: false, error: { code: 'DRIVE_NOT_CONFIGURED', message: 'Google Drive integration is not configured', retryable: false } });
    }

    const { google } = await import('googleapis');
    const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);

    const state = createSignedState(user.id, 'google_drive');

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: [
        // drive.readonly lets us list & read ALL user files (not just app-created ones).
        // drive.file alone only returns files explicitly opened/created with this app.
        'https://www.googleapis.com/auth/drive.readonly',
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
      ],
      state,
    });

    return res.json({ success: true, data: { authUrl } });
  } catch (err: any) {
    console.error('Drive init error:', err.message);
    return res.status(500).json({ success: false, error: { code: 'DRIVE_INIT_FAILED', message: err.message, retryable: true } });
  }
});

// GOOGLE DRIVE — OAuth Callback
router.get('/drive/callback', async (req: Request, res: Response) => {
  try {
    const { code, state, error: oauthError } = req.query;
    if (oauthError) {
      console.error('Drive OAuth error:', oauthError);
      return res.send(buildPopupResponse(false, 'google_drive', String(oauthError)));
    }
    if (!code || !state) {
      return res.send(buildPopupResponse(false, 'google_drive', 'Missing code or state parameter'));
    }

    const pending = verifySignedState(String(state));
    if (!pending || pending.provider !== 'google_drive') {
      return res.send(buildPopupResponse(false, 'google_drive', 'Invalid or expired OAuth state — please try again'));
    }

    const { google } = await import('googleapis');
    const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);

    const { tokens } = await oauth2Client.getToken(String(code));
    if (!tokens.access_token) {
      return res.send(buildPopupResponse(false, 'google_drive', 'Failed to acquire tokens from Google'));
    }

    oauth2Client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    let userEmail: string | null = null;
    let providerUserId: string | null = null;
    try {
      const userInfo = await oauth2.userinfo.get();
      userEmail = userInfo.data.email ?? null;
      providerUserId = userInfo.data.id ?? null;
    } catch { /* non-fatal */ }

    await saveToken(pending.userId, 'google_drive', {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      tokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : new Date(Date.now() + 3600 * 1000),
      scope: tokens.scope ?? null,
      providerUserId,
      providerEmail: userEmail,
      metadata: JSON.stringify({ tokenType: tokens.token_type }),
    });

    return res.send(buildPopupResponse(true, 'google_drive'));
  } catch (err: any) {
    console.error('Drive callback error:', err.message);
    return res.send(buildPopupResponse(false, 'google_drive', err.message));
  }
});

// GOOGLE DRIVE — Disconnect
router.post('/drive/disconnect', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const deleted = await deleteToken(user.id, 'google_drive');
    if (!deleted) {
      return res.status(404).json({ success: false, error: { code: 'USER_NOT_CONNECTED', message: 'Google Drive is not connected', retryable: false } });
    }
    return res.json({ success: true, data: { disconnected: true } });
  } catch (err: any) {
    console.error('Drive disconnect error:', err.message);
    return res.status(500).json({ success: false, error: { code: 'DISCONNECT_FAILED', message: err.message, retryable: true } });
  }
});

// GOOGLE DRIVE — Connection Status
router.get('/drive/status', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const connected = await isConnected(user.id, 'google_drive');
    return res.json({ success: true, data: { connected } });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: 'STATUS_CHECK_FAILED', message: err.message, retryable: true } });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GOOGLE CALENDAR — OAuth Init
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/calendar/init', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    if (!user?.id) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'User not authenticated', retryable: false } });
    }

    const connected = await isConnected(user.id, 'google_calendar');
    if (connected) {
      return res.status(400).json({ success: false, error: { code: 'ALREADY_CONNECTED', message: 'Google Calendar is already connected. Disconnect first.', retryable: false } });
    }

    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
      return res.status(500).json({ success: false, error: { code: 'CALENDAR_NOT_CONFIGURED', message: 'Google Calendar integration is not configured', retryable: false } });
    }

    const { google } = await import('googleapis');
    const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_CALENDAR_REDIRECT_URI);

    const state = createSignedState(user.id, 'google_calendar');

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: [
        'https://www.googleapis.com/auth/calendar',
        'https://www.googleapis.com/auth/calendar.events',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
      ],
      state,
    });

    return res.json({ success: true, data: { authUrl } });
  } catch (err: any) {
    console.error('Calendar init error:', err.message);
    return res.status(500).json({ success: false, error: { code: 'CALENDAR_INIT_FAILED', message: err.message, retryable: true } });
  }
});

// GOOGLE CALENDAR — OAuth Callback
router.get('/calendar/callback', async (req: Request, res: Response) => {
  try {
    const { code, state, error: oauthError } = req.query;
    if (oauthError) {
      console.error('Calendar OAuth error:', oauthError);
      return res.send(buildPopupResponse(false, 'google_calendar', String(oauthError)));
    }
    if (!code || !state) {
      return res.send(buildPopupResponse(false, 'google_calendar', 'Missing code or state parameter'));
    }

    const pending = verifySignedState(String(state));
    if (!pending || pending.provider !== 'google_calendar') {
      return res.send(buildPopupResponse(false, 'google_calendar', 'Invalid or expired OAuth state — please try again'));
    }

    const { google } = await import('googleapis');
    const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_CALENDAR_REDIRECT_URI);

    const { tokens } = await oauth2Client.getToken(String(code));
    if (!tokens.access_token) {
      return res.send(buildPopupResponse(false, 'google_calendar', 'Failed to acquire tokens from Google'));
    }

    oauth2Client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    let userEmail: string | null = null;
    let providerUserId: string | null = null;
    try {
      const userInfo = await oauth2.userinfo.get();
      userEmail = userInfo.data.email ?? null;
      providerUserId = userInfo.data.id ?? null;
    } catch { /* non-fatal */ }

    await saveToken(pending.userId, 'google_calendar', {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      tokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : new Date(Date.now() + 3600 * 1000),
      scope: tokens.scope ?? null,
      providerUserId,
      providerEmail: userEmail,
      metadata: JSON.stringify({ tokenType: tokens.token_type }),
    });

    return res.send(buildPopupResponse(true, 'google_calendar'));
  } catch (err: any) {
    console.error('Calendar callback error:', err.message);
    return res.send(buildPopupResponse(false, 'google_calendar', err.message));
  }
});

// GOOGLE CALENDAR — Disconnect
router.post('/calendar/disconnect', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const deleted = await deleteToken(user.id, 'google_calendar');
    if (!deleted) {
      return res.status(404).json({ success: false, error: { code: 'USER_NOT_CONNECTED', message: 'Google Calendar is not connected', retryable: false } });
    }
    return res.json({ success: true, data: { disconnected: true } });
  } catch (err: any) {
    console.error('Calendar disconnect error:', err.message);
    return res.status(500).json({ success: false, error: { code: 'DISCONNECT_FAILED', message: err.message, retryable: true } });
  }
});

// GOOGLE CALENDAR — Connection Status
router.get('/calendar/status', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const connected = await isConnected(user.id, 'google_calendar');
    return res.json({ success: true, data: { connected } });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: 'STATUS_CHECK_FAILED', message: err.message, retryable: true } });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GMAIL — OAuth Init
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/gmail/init', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    if (!user?.id) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'User not authenticated', retryable: false } });
    }

    const connected = await isConnected(user.id, 'gmail' as Provider);
    if (connected) {
      return res.status(400).json({ success: false, error: { code: 'ALREADY_CONNECTED', message: 'Gmail is already connected. Disconnect first.', retryable: false } });
    }

    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
      return res.status(500).json({ success: false, error: { code: 'GMAIL_NOT_CONFIGURED', message: 'Gmail integration is not configured', retryable: false } });
    }

    const { google } = await import('googleapis');
    const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_GMAIL_REDIRECT_URI);

    const state = createSignedState(user.id, 'gmail' as Provider);

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.send',
        'https://www.googleapis.com/auth/gmail.modify',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
      ],
      state,
    });

    return res.json({ success: true, data: { authUrl } });
  } catch (err: any) {
    console.error('Gmail init error:', err.message);
    return res.status(500).json({ success: false, error: { code: 'GMAIL_INIT_FAILED', message: err.message, retryable: true } });
  }
});

// GMAIL — OAuth Callback
router.get('/gmail/callback', async (req: Request, res: Response) => {
  try {
    const { code, state, error: oauthError } = req.query;
    if (oauthError) {
      console.error('Gmail OAuth error:', oauthError);
      return res.send(buildPopupResponse(false, 'gmail', String(oauthError)));
    }
    if (!code || !state) {
      return res.send(buildPopupResponse(false, 'gmail', 'Missing code or state parameter'));
    }

    const pending = verifySignedState(String(state));
    if (!pending || pending.provider !== ('gmail' as Provider)) {
      return res.send(buildPopupResponse(false, 'gmail', 'Invalid or expired OAuth state — please try again'));
    }

    const { google } = await import('googleapis');
    const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_GMAIL_REDIRECT_URI);

    const { tokens } = await oauth2Client.getToken(String(code));
    if (!tokens.access_token) {
      return res.send(buildPopupResponse(false, 'gmail', 'Failed to acquire tokens from Google'));
    }

    oauth2Client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    let userEmail: string | null = null;
    let providerUserId: string | null = null;
    try {
      const userInfo = await oauth2.userinfo.get();
      userEmail = userInfo.data.email ?? null;
      providerUserId = userInfo.data.id ?? null;
    } catch { /* non-fatal */ }

    await saveToken(pending.userId, 'gmail' as Provider, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      tokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : new Date(Date.now() + 3600 * 1000),
      scope: tokens.scope ?? null,
      providerUserId,
      providerEmail: userEmail,
      metadata: JSON.stringify({ tokenType: tokens.token_type }),
    });

    return res.send(buildPopupResponse(true, 'gmail'));
  } catch (err: any) {
    console.error('Gmail callback error:', err.message);
    return res.send(buildPopupResponse(false, 'gmail', err.message));
  }
});

// GMAIL — Disconnect
router.post('/gmail/disconnect', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const deleted = await deleteToken(user.id, 'gmail' as Provider);
    if (!deleted) {
      return res.status(404).json({ success: false, error: { code: 'USER_NOT_CONNECTED', message: 'Gmail is not connected', retryable: false } });
    }
    return res.json({ success: true, data: { disconnected: true } });
  } catch (err: any) {
    console.error('Gmail disconnect error:', err.message);
    return res.status(500).json({ success: false, error: { code: 'DISCONNECT_FAILED', message: err.message, retryable: true } });
  }
});

// GMAIL — Connection Status
router.get('/gmail/status', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const connected = await isConnected(user.id, 'gmail' as Provider);
    return res.json({ success: true, data: { connected } });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: 'STATUS_CHECK_FAILED', message: err.message, retryable: true } });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// DROPBOX
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/dropbox/init', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    if (!user?.id) return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED' } });

    const connected = await isConnected(user.id, 'dropbox');
    if (connected) return res.status(400).json({ success: false, error: { code: 'ALREADY_CONNECTED', message: 'Already connected. Disconnect first.' } });
    if (!process.env.DROPBOX_CLIENT_ID || !process.env.DROPBOX_CLIENT_SECRET) return res.status(500).json({ success: false, error: { code: 'NOT_CONFIGURED', message: 'Dropbox credentials not configured' } });

    const state = createSignedState(user.id, 'dropbox' as Provider);

    const redirectUri = process.env.DROPBOX_REDIRECT_URI || `${process.env.APP_URL || 'http://localhost:4000'}/api/auth/dropbox/callback`;
    const params = new URLSearchParams({
      client_id: process.env.DROPBOX_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: 'code',
      state,
      token_access_type: 'offline',
      // Required scopes for file browsing + shareable links
      scope: 'files.metadata.read files.content.read sharing.write sharing.read account_info.read',
    });

    const authUrl = `https://www.dropbox.com/oauth2/authorize?${params.toString()}`;
    return res.json({ success: true, data: { authUrl } });
  } catch (err: any) {
    console.error('Dropbox init error:', err.message);
    return res.status(500).json({ success: false, error: { code: 'INIT_FAILED', message: err.message } });
  }
});

router.get('/dropbox/callback', async (req: Request, res: Response) => {
  const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
  const redir = (ok: boolean, err?: string) => {
    const base = `${FRONTEND_URL}/apps-integrations/dropbox`;
    return res.redirect(ok ? `${base}?status=connected` : `${base}?status=error&reason=${encodeURIComponent(err || 'unknown')}`);
  };
  try {
    const { code, state, error: oauthError } = req.query;
    if (oauthError) return redir(false, String(oauthError));
    if (!code || !state) return redir(false, 'missing_params');

    const stateData = verifySignedState(String(state));
    if (!stateData || stateData.provider !== ('dropbox' as Provider)) return redir(false, 'invalid_state');
    const userId = stateData.userId;

    const redirectUri = process.env.DROPBOX_REDIRECT_URI || `${process.env.APP_URL || 'http://localhost:4000'}/api/auth/dropbox/callback`;

    const tokenResponse = await fetch('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(code),
        grant_type: 'authorization_code',
        client_id: process.env.DROPBOX_CLIENT_ID!,
        client_secret: process.env.DROPBOX_CLIENT_SECRET!,
        redirect_uri: redirectUri,
      }),
    });

    const tokens = await tokenResponse.json() as any;
    if (tokens.error) return redir(false, tokens.error_description || tokens.error);

    // Get user info
    let dropboxEmail: string | null = null;
    let dropboxUserId: string | null = null;
    try {
      const userRes = await fetch('https://api.dropboxapi.com/2/users/get_current_account', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json' },
        body: 'null',
      });
      const userInfo = await userRes.json() as any;
      dropboxEmail = userInfo.email || null;
      dropboxUserId = userInfo.account_id || null;
    } catch {}

    console.log('Dropbox OAuth: saving tokens for user', userId);
    await saveToken(userId, 'dropbox', {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      tokenExpiry: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : new Date(Date.now() + 3600 * 1000),
      scope: tokens.scope ?? null,
      providerUserId: dropboxUserId,
      providerEmail: dropboxEmail,
      metadata: JSON.stringify({ tokenType: tokens.token_type, uid: tokens.uid }),
    });

    return redir(true);
  } catch (err: any) {
    console.error('Dropbox callback error:', err.message);
    return redir(false, err.message);
  }
});

router.post('/dropbox/disconnect', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const deleted = await deleteToken(user.id, 'dropbox');
    if (!deleted) return res.status(404).json({ success: false, error: { code: 'NOT_CONNECTED' } });
    return res.json({ success: true, data: { disconnected: true } });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: 'DISCONNECT_FAILED', message: err.message } });
  }
});

router.get('/dropbox/status', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const connected = await isConnected(user.id, 'dropbox');
    return res.json({ success: true, data: { connected } });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: 'STATUS_CHECK_FAILED', message: err.message } });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GITHUB
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/github/init', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    if (!user?.id) return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED' } });

    const connected = await isConnected(user.id, 'github');
    if (connected) return res.status(400).json({ success: false, error: { code: 'ALREADY_CONNECTED', message: 'GitHub is already connected. Disconnect first.' } });
    if (!process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_CLIENT_SECRET) return res.status(500).json({ success: false, error: { code: 'NOT_CONFIGURED', message: 'GitHub credentials not configured' } });

    const state = createSignedState(user.id, 'github' as Provider);

    const redirectUri = process.env.GITHUB_REDIRECT_URI || `${process.env.APP_URL || 'http://localhost:4000'}/api/auth/github/callback`;
    const params = new URLSearchParams({
      client_id: process.env.GITHUB_CLIENT_ID,
      redirect_uri: redirectUri,
      scope: 'repo user read:org',
      state,
    });

    const authUrl = `https://github.com/login/oauth/authorize?${params.toString()}`;
    return res.json({ success: true, data: { authUrl } });
  } catch (err: any) {
    console.error('GitHub init error:', err.message);
    return res.status(500).json({ success: false, error: { code: 'INIT_FAILED', message: err.message } });
  }
});

router.get('/github/callback', async (req: Request, res: Response) => {
  const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
  const redir = (ok: boolean, err?: string) => {
    const base = `${FRONTEND_URL}/apps-integrations/github`;
    return res.redirect(ok ? `${base}?status=connected` : `${base}?status=error&reason=${encodeURIComponent(err || 'unknown')}`);
  };
  try {
    const { code, state, error: oauthError } = req.query;
    if (oauthError) return redir(false, String(oauthError));
    if (!code || !state) return redir(false, 'missing_params');

    const stateData = verifySignedState(String(state));
    if (!stateData || stateData.provider !== ('github' as Provider)) return redir(false, 'invalid_state');
    const userId = stateData.userId;

    const redirectUri = process.env.GITHUB_REDIRECT_URI || `${process.env.APP_URL || 'http://localhost:4000'}/api/auth/github/callback`;

    // Exchange code for token
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code: String(code),
        redirect_uri: redirectUri,
      }),
    });

    const tokens = await tokenResponse.json() as any;
    if (tokens.error) return redir(false, tokens.error_description || tokens.error);

    // Get user info
    let githubEmail: string | null = null;
    let githubUserId: string | null = null;
    let githubUsername: string | null = null;
    try {
      const userRes = await fetch('https://api.github.com/user', {
        headers: { 'Authorization': `Bearer ${tokens.access_token}`, 'User-Agent': 'Nexus-App', 'Accept': 'application/vnd.github+json' },
      });
      const userInfo = await userRes.json() as any;
      githubEmail = userInfo.email || null;
      githubUserId = String(userInfo.id) || null;
      githubUsername = userInfo.login || null;
    } catch {}

    console.log('GitHub OAuth: saving tokens for user', userId);
    await saveToken(userId, 'github' as Provider, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      tokenExpiry: new Date(Date.now() + 365 * 24 * 3600 * 1000), // GitHub tokens don't expire unless revoked
      scope: tokens.scope ?? null,
      providerUserId: githubUserId,
      providerEmail: githubEmail,
      metadata: JSON.stringify({ tokenType: tokens.token_type, username: githubUsername }),
    });

    return redir(true);
  } catch (err: any) {
    console.error('GitHub callback error:', err.message);
    return redir(false, err.message);
  }
});

router.post('/github/disconnect', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const deleted = await deleteToken(user.id, 'github' as Provider);
    if (!deleted) return res.status(404).json({ success: false, error: { code: 'NOT_CONNECTED' } });
    return res.json({ success: true, data: { disconnected: true } });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: 'DISCONNECT_FAILED', message: err.message } });
  }
});

router.get('/github/status', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const connected = await isConnected(user.id, 'github' as Provider);
    return res.json({ success: true, data: { connected } });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: 'STATUS_CHECK_FAILED', message: err.message } });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// FIGMA
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/figma/init', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    if (!user?.id) return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED' } });

    const connected = await isConnected(user.id, 'figma' as Provider);
    if (connected) return res.status(400).json({ success: false, error: { code: 'ALREADY_CONNECTED', message: 'Figma is already connected. Disconnect first.' } });
    if (!process.env.FIGMA_CLIENT_ID || !process.env.FIGMA_CLIENT_SECRET) return res.status(500).json({ success: false, error: { code: 'NOT_CONFIGURED', message: 'Figma credentials not configured' } });

    const state = createSignedState(user.id, 'figma' as Provider);

    const redirectUri = process.env.FIGMA_REDIRECT_URI || `${process.env.APP_URL || 'http://localhost:4000'}/api/auth/figma/callback`;
    const params = new URLSearchParams({
      client_id: process.env.FIGMA_CLIENT_ID,
      redirect_uri: redirectUri,
      scope: 'current_user:read,file_content:read,file_metadata:read,projects:read',
      state,
      response_type: 'code',
    });

    const authUrl = `https://www.figma.com/oauth?${params.toString()}`;
    return res.json({ success: true, data: { authUrl } });
  } catch (err: any) {
    console.error('Figma init error:', err.message);
    return res.status(500).json({ success: false, error: { code: 'INIT_FAILED', message: err.message } });
  }
});

router.get('/figma/callback', async (req: Request, res: Response) => {
  const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
  const redir = (ok: boolean, err?: string) => {
    const base = `${FRONTEND_URL}/apps-integrations/figma`;
    return res.redirect(ok ? `${base}?status=connected` : `${base}?status=error&reason=${encodeURIComponent(err || 'unknown')}`);
  };
  try {
    const { code, state, error: oauthError } = req.query;
    if (oauthError) return redir(false, String(oauthError));
    if (!code || !state) return redir(false, 'missing_params');

    const stateData = verifySignedState(String(state));
    if (!stateData || stateData.provider !== ('figma' as Provider)) return redir(false, 'invalid_state');
    const userId = stateData.userId;

    const redirectUri = process.env.FIGMA_REDIRECT_URI || `${process.env.APP_URL || 'http://localhost:4000'}/api/auth/figma/callback`;

    // Exchange code for token
    const tokenResponse = await fetch('https://api.figma.com/v1/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.FIGMA_CLIENT_ID!,
        client_secret: process.env.FIGMA_CLIENT_SECRET!,
        redirect_uri: redirectUri,
        code: String(code),
        grant_type: 'authorization_code',
      }),
    });

    const tokens = await tokenResponse.json() as any;
    if (tokens.error) return redir(false, tokens.message || tokens.error);

    // Get user info
    let figmaEmail: string | null = null;
    let figmaUserId: string | null = null;
    let figmaHandle: string | null = null;
    try {
      const userRes = await fetch('https://api.figma.com/v1/me', {
        headers: { 'Authorization': `Bearer ${tokens.access_token}` },
      });
      const userInfo = await userRes.json() as any;
      figmaEmail = userInfo.email || null;
      figmaUserId = userInfo.id || null;
      figmaHandle = userInfo.handle || null;
    } catch {}

    console.log('Figma OAuth: saving tokens for user', userId);
    await saveToken(userId, 'figma' as Provider, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      tokenExpiry: tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000)
        : new Date(Date.now() + 90 * 24 * 3600 * 1000),
      scope: 'files:read',
      providerUserId: figmaUserId,
      providerEmail: figmaEmail,
      metadata: JSON.stringify({ handle: figmaHandle }),
    });

    return redir(true);
  } catch (err: any) {
    console.error('Figma callback error:', err.message);
    return redir(false, err.message);
  }
});

router.post('/figma/disconnect', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const deleted = await deleteToken(user.id, 'figma' as Provider);
    if (!deleted) return res.status(404).json({ success: false, error: { code: 'NOT_CONNECTED' } });
    return res.json({ success: true, data: { disconnected: true } });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: 'DISCONNECT_FAILED', message: err.message } });
  }
});

router.get('/figma/status', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const connected = await isConnected(user.id, 'figma' as Provider);
    return res.json({ success: true, data: { connected } });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: 'STATUS_CHECK_FAILED', message: err.message } });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// JIRA
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/jira/init', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    if (!user?.id) return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED' } });

    const connected = await isConnected(user.id, 'jira' as Provider);
    if (connected) return res.status(400).json({ success: false, error: { code: 'ALREADY_CONNECTED', message: 'Jira is already connected. Disconnect first.' } });
    if (!process.env.JIRA_CLIENT_ID || !process.env.JIRA_CLIENT_SECRET) return res.status(500).json({ success: false, error: { code: 'NOT_CONFIGURED', message: 'Jira credentials not configured' } });

    const state = createSignedState(user.id, 'jira' as Provider);

    const redirectUri = process.env.JIRA_REDIRECT_URI || `${process.env.APP_URL || 'http://localhost:4000'}/api/auth/jira/callback`;
    const params = new URLSearchParams({
      audience: 'api.atlassian.com',
      client_id: process.env.JIRA_CLIENT_ID,
      scope: 'read:jira-work write:jira-work read:jira-user manage:jira-project manage:jira-webhook offline_access',
      redirect_uri: redirectUri,
      state,
      response_type: 'code',
      prompt: 'consent',
    });

    const authUrl = `https://auth.atlassian.com/authorize?${params.toString()}`;
    return res.json({ success: true, data: { authUrl } });
  } catch (err: any) {
    console.error('Jira init error:', err.message);
    return res.status(500).json({ success: false, error: { code: 'INIT_FAILED', message: err.message } });
  }
});

router.get('/jira/callback', async (req: Request, res: Response) => {
  const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
  const redir = (ok: boolean, err?: string) => {
    const base = `${FRONTEND_URL}/apps-integrations/jira`;
    return res.redirect(ok ? `${base}?status=connected` : `${base}?status=error&reason=${encodeURIComponent(err || 'unknown')}`);
  };
  try {
    const { code, state, error: oauthError } = req.query;
    if (oauthError) return redir(false, String(oauthError));
    if (!code || !state) return redir(false, 'missing_params');

    const stateData = verifySignedState(String(state));
    if (!stateData || stateData.provider !== ('jira' as Provider)) return redir(false, 'invalid_state');
    const userId = stateData.userId;

    const redirectUri = process.env.JIRA_REDIRECT_URI || `${process.env.APP_URL || 'http://localhost:4000'}/api/auth/jira/callback`;

    // Exchange code for tokens
    const tokenResponse = await fetch('https://auth.atlassian.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: process.env.JIRA_CLIENT_ID!,
        client_secret: process.env.JIRA_CLIENT_SECRET!,
        code: String(code),
        redirect_uri: redirectUri,
      }),
    });

    const tokens = await tokenResponse.json() as any;
    if (tokens.error) return redir(false, tokens.error_description || tokens.error);

    // Get accessible resources (Jira cloud sites)
    let jiraCloudId: string | null = null;
    let jiraSiteName: string | null = null;
    let jiraEmail: string | null = null;
    let jiraUserId: string | null = null;

    try {
      // Get cloud ID (which Jira site the user authorized)
      const resourcesRes = await fetch('https://api.atlassian.com/oauth/token/accessible-resources', {
        headers: { 'Authorization': `Bearer ${tokens.access_token}`, 'Accept': 'application/json' },
      });
      const resources = await resourcesRes.json() as any[];
      if (resources.length > 0) {
        jiraCloudId = resources[0].id;
        jiraSiteName = resources[0].name;
      }

      // Get user info
      if (jiraCloudId) {
        const userRes = await fetch(`https://api.atlassian.com/ex/jira/${jiraCloudId}/rest/api/3/myself`, {
          headers: { 'Authorization': `Bearer ${tokens.access_token}`, 'Accept': 'application/json' },
        });
        const userInfo = await userRes.json() as any;
        jiraEmail = userInfo.emailAddress || null;
        jiraUserId = userInfo.accountId || null;
      }
    } catch {}

    console.log('Jira OAuth: saving tokens for user', userId);
    await saveToken(userId, 'jira' as Provider, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      tokenExpiry: tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000)
        : new Date(Date.now() + 3600 * 1000),
      scope: tokens.scope ?? null,
      providerUserId: jiraUserId,
      providerEmail: jiraEmail,
      metadata: JSON.stringify({ cloudId: jiraCloudId, siteName: jiraSiteName }),
    });

    return redir(true);
  } catch (err: any) {
    console.error('Jira callback error:', err.message);
    return redir(false, err.message);
  }
});

router.post('/jira/disconnect', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const deleted = await deleteToken(user.id, 'jira' as Provider);
    if (!deleted) return res.status(404).json({ success: false, error: { code: 'NOT_CONNECTED' } });
    return res.json({ success: true, data: { disconnected: true } });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: 'DISCONNECT_FAILED', message: err.message } });
  }
});

router.get('/jira/status', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const connected = await isConnected(user.id, 'jira' as Provider);
    return res.json({ success: true, data: { connected } });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: 'STATUS_CHECK_FAILED', message: err.message } });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// MICROSOFT (shared OAuth for MS Teams, Outlook Calendar, OneDrive, Outlook Email)
// ═══════════════════════════════════════════════════════════════════════════════

// Microsoft provider → Graph API scopes mapping
const MICROSOFT_SCOPES: Record<string, string[]> = {
  ms_teams: [
    'openid', 'profile', 'email', 'offline_access',
    'https://graph.microsoft.com/Team.ReadBasic.All',
    'https://graph.microsoft.com/Channel.ReadBasic.All',
    'https://graph.microsoft.com/Chat.Read',
    'https://graph.microsoft.com/ChatMessage.Send',
  ],
  outlook_calendar: [
    'openid', 'profile', 'email', 'offline_access',
    'https://graph.microsoft.com/Calendars.ReadWrite',
    'https://graph.microsoft.com/User.Read',
  ],
  onedrive: [
    'openid', 'profile', 'email', 'offline_access',
    'https://graph.microsoft.com/Files.ReadWrite.All',
    'https://graph.microsoft.com/User.Read',
  ],
  outlook_email: [
    'openid', 'profile', 'email', 'offline_access',
    'https://graph.microsoft.com/Mail.ReadWrite',
    'https://graph.microsoft.com/Mail.Send',
    'https://graph.microsoft.com/User.Read',
  ],
};

// Microsoft provider → frontend settings path
const MICROSOFT_SETTINGS_PATH: Record<string, string> = {
  ms_teams: '/apps-integrations/ms-teams',
  outlook_calendar: '/apps-integrations/outlook-calendar',
  onedrive: '/apps-integrations/onedrive',
  outlook_email: '/apps-integrations/outlook-email',
};

// Microsoft provider → route prefix
const MICROSOFT_ROUTE_PREFIX: Record<string, string> = {
  ms_teams: 'ms-teams',
  outlook_calendar: 'outlook-calendar',
  onedrive: 'onedrive',
  outlook_email: 'outlook-email',
};

// Create OAuth routes for each Microsoft provider
for (const [providerKey, routePrefix] of Object.entries(MICROSOFT_ROUTE_PREFIX)) {
  const scopes = MICROSOFT_SCOPES[providerKey];
  const settingsPath = MICROSOFT_SETTINGS_PATH[providerKey];

  // INIT — redirect user to Microsoft OAuth
  router.get(`/${routePrefix}/init`, requireAuth, async (req: Request, res: Response) => {
    try {
      const user = req.user as any;
      if (!user?.id) return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'User not authenticated' } });

      const connected = await isConnected(user.id, providerKey as Provider);
      if (connected) return res.status(400).json({ success: false, error: { code: 'ALREADY_CONNECTED', message: `${providerKey} is already connected. Disconnect first.` } });

      if (!process.env.AZURE_CLIENT_ID || !process.env.AZURE_CLIENT_SECRET) {
        return res.status(500).json({ success: false, error: { code: 'NOT_CONFIGURED', message: 'Azure AD credentials not configured' } });
      }

      const state = createSignedState(user.id, providerKey as Provider);
      const redirectUri = process.env[`AZURE_${providerKey.toUpperCase()}_REDIRECT_URI`]
        || process.env.AZURE_REDIRECT_URI
        || `${process.env.APP_URL || 'http://localhost:4000'}/api/auth/${routePrefix}/callback`;

      const params = new URLSearchParams({
        client_id: process.env.AZURE_CLIENT_ID,
        response_type: 'code',
        redirect_uri: redirectUri,
        scope: scopes.join(' '),
        state,
        response_mode: 'query',
        prompt: 'consent',
      });

      const tenantId = process.env.AZURE_TENANT_ID || 'common';
      const authUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?${params.toString()}`;
      return res.json({ success: true, data: { authUrl } });
    } catch (err: any) {
      console.error(`${providerKey} init error:`, err.message);
      return res.status(500).json({ success: false, error: { code: 'INIT_FAILED', message: err.message } });
    }
  });

  // CALLBACK — exchange code for tokens
  router.get(`/${routePrefix}/callback`, async (req: Request, res: Response) => {
    const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
    const redir = (ok: boolean, err?: string) => {
      const base = `${FRONTEND_URL}${settingsPath}`;
      return res.redirect(ok ? `${base}?status=connected` : `${base}?status=error&reason=${encodeURIComponent(err || 'unknown')}`);
    };

    try {
      const { code, state, error: oauthError } = req.query;
      if (oauthError) return redir(false, String(oauthError));
      if (!code || !state) return redir(false, 'missing_params');

      const stateData = verifySignedState(String(state));
      if (!stateData || stateData.provider !== (providerKey as Provider)) return redir(false, 'invalid_state');
      const userId = stateData.userId;

      const redirectUri = process.env[`AZURE_${providerKey.toUpperCase()}_REDIRECT_URI`]
        || process.env.AZURE_REDIRECT_URI
        || `${process.env.APP_URL || 'http://localhost:4000'}/api/auth/${routePrefix}/callback`;

      // Exchange code for tokens
      const tokenResponse = await fetch(`https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID || 'common'}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: process.env.AZURE_CLIENT_ID!,
          client_secret: process.env.AZURE_CLIENT_SECRET!,
          code: String(code),
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
          scope: scopes.join(' '),
        }),
      });

      const tokens = await tokenResponse.json() as any;
      if (tokens.error) return redir(false, tokens.error_description || tokens.error);

      // Get user info from Microsoft Graph
      let msEmail: string | null = null;
      let msUserId: string | null = null;
      let msDisplayName: string | null = null;
      try {
        const userRes = await fetch('https://graph.microsoft.com/v1.0/me', {
          headers: { 'Authorization': `Bearer ${tokens.access_token}` },
        });
        const userInfo = await userRes.json() as any;
        msEmail = userInfo.mail || userInfo.userPrincipalName || null;
        msUserId = userInfo.id || null;
        msDisplayName = userInfo.displayName || null;
      } catch { /* non-fatal */ }

      await saveToken(userId, providerKey as Provider, {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? null,
        tokenExpiry: tokens.expires_in
          ? new Date(Date.now() + tokens.expires_in * 1000)
          : new Date(Date.now() + 3600 * 1000),
        scope: tokens.scope ?? null,
        providerUserId: msUserId,
        providerEmail: msEmail,
        metadata: JSON.stringify({ displayName: msDisplayName, tokenType: tokens.token_type }),
      });

      return redir(true);
    } catch (err: any) {
      console.error(`${providerKey} callback error:`, err.message);
      return redir(false, err.message);
    }
  });

  // DISCONNECT
  router.post(`/${routePrefix}/disconnect`, requireAuth, async (req: Request, res: Response) => {
    try {
      const user = req.user as any;
      const deleted = await deleteToken(user.id, providerKey as Provider);
      if (!deleted) return res.status(404).json({ success: false, error: { code: 'NOT_CONNECTED' } });
      return res.json({ success: true, data: { disconnected: true } });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: 'DISCONNECT_FAILED', message: err.message } });
    }
  });

  // STATUS
  router.get(`/${routePrefix}/status`, requireAuth, async (req: Request, res: Response) => {
    try {
      const user = req.user as any;
      const connected = await isConnected(user.id, providerKey as Provider);
      return res.json({ success: true, data: { connected } });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: { code: 'STATUS_CHECK_FAILED', message: err.message } });
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SALESFORCE
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/salesforce/init', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    if (!user?.id) return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED' } });

    const connected = await isConnected(user.id, 'salesforce' as Provider);
    if (connected) return res.status(400).json({ success: false, error: { code: 'ALREADY_CONNECTED', message: 'Salesforce is already connected. Disconnect first.' } });
    if (!process.env.SALESFORCE_CLIENT_ID || !process.env.SALESFORCE_CLIENT_SECRET) return res.status(500).json({ success: false, error: { code: 'NOT_CONFIGURED', message: 'Salesforce credentials not configured' } });

    const state = createSignedState(user.id, 'salesforce' as Provider);

    const redirectUri = process.env.SALESFORCE_REDIRECT_URI || `${process.env.APP_URL || 'http://localhost:4000'}/api/auth/salesforce/callback`;
    const loginUrl = process.env.SALESFORCE_LOGIN_URL || 'https://login.salesforce.com';
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: process.env.SALESFORCE_CLIENT_ID,
      redirect_uri: redirectUri,
      scope: 'api refresh_token id full',
      state,
    });

    const authUrl = `${loginUrl}/services/oauth2/authorize?${params.toString()}`;
    return res.json({ success: true, data: { authUrl } });
  } catch (err: any) {
    console.error('Salesforce init error:', err.message);
    return res.status(500).json({ success: false, error: { code: 'INIT_FAILED', message: err.message } });
  }
});

router.get('/salesforce/callback', async (req: Request, res: Response) => {
  const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
  const redir = (ok: boolean, err?: string) => {
    const base = `${FRONTEND_URL}/apps-integrations/salesforce`;
    return res.redirect(ok ? `${base}?status=connected` : `${base}?status=error&reason=${encodeURIComponent(err || 'unknown')}`);
  };
  try {
    const { code, state, error: oauthError } = req.query;
    if (oauthError) return redir(false, String(oauthError));
    if (!code || !state) return redir(false, 'missing_params');

    const stateData = verifySignedState(String(state));
    if (!stateData || stateData.provider !== ('salesforce' as Provider)) return redir(false, 'invalid_state');
    const userId = stateData.userId;

    const redirectUri = process.env.SALESFORCE_REDIRECT_URI || `${process.env.APP_URL || 'http://localhost:4000'}/api/auth/salesforce/callback`;
    const loginUrl = process.env.SALESFORCE_LOGIN_URL || 'https://login.salesforce.com';

    // Exchange code for tokens
    const tokenResponse = await fetch(`${loginUrl}/services/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: String(code),
        client_id: process.env.SALESFORCE_CLIENT_ID!,
        client_secret: process.env.SALESFORCE_CLIENT_SECRET!,
        redirect_uri: redirectUri,
      }),
    });

    const tokens = await tokenResponse.json() as any;
    if (tokens.error) return redir(false, tokens.error_description || tokens.error);

    // Get user info from Salesforce identity endpoint
    let sfEmail: string | null = null;
    let sfUserId: string | null = null;
    let sfDisplayName: string | null = null;
    try {
      const userRes = await fetch(tokens.id, {
        headers: { 'Authorization': `Bearer ${tokens.access_token}` },
      });
      const userInfo = await userRes.json() as any;
      sfEmail = userInfo.email || null;
      sfUserId = userInfo.user_id || null;
      sfDisplayName = userInfo.display_name || null;
    } catch { /* non-fatal */ }

    console.log('Salesforce OAuth: saving tokens for user', userId);
    await saveToken(userId, 'salesforce' as Provider, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      tokenExpiry: tokens.issued_at
        ? new Date(Number(tokens.issued_at) + 2 * 3600 * 1000) // Salesforce access tokens ~2h
        : new Date(Date.now() + 2 * 3600 * 1000),
      scope: tokens.scope ?? null,
      providerUserId: sfUserId,
      providerEmail: sfEmail,
      metadata: JSON.stringify({
        instanceUrl: tokens.instance_url,
        tokenType: tokens.token_type,
        displayName: sfDisplayName,
      }),
    });

    return redir(true);
  } catch (err: any) {
    console.error('Salesforce callback error:', err.message);
    return redir(false, err.message);
  }
});

router.post('/salesforce/disconnect', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const deleted = await deleteToken(user.id, 'salesforce' as Provider);
    if (!deleted) return res.status(404).json({ success: false, error: { code: 'NOT_CONNECTED' } });
    return res.json({ success: true, data: { disconnected: true } });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: 'DISCONNECT_FAILED', message: err.message } });
  }
});

router.get('/salesforce/status', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const connected = await isConnected(user.id, 'salesforce' as Provider);
    return res.json({ success: true, data: { connected } });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: 'STATUS_CHECK_FAILED', message: err.message } });
  }
});

// ─── Popup Response Helper ───────────────────────────────────────────────────
function buildPopupResponse(success: boolean, provider: string, errorMessage?: string): string {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  const redirectUrl = `${frontendUrl}/apps-integrations?provider=${provider}&connected=${success}${errorMessage ? '&error=' + encodeURIComponent(errorMessage) : ''}`;
  const payload = JSON.stringify({ provider, connected: success, error: errorMessage || null });

  return `<!DOCTYPE html>
<html><head><title>OAuth Complete</title></head>
<body>
<script>
  (function() {
    var redirectUrl = '${redirectUrl}';
    var payload = ${payload};
    var frontendUrl = '${frontendUrl}';
    var sent = false;

    try {
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage(payload, frontendUrl);
        sent = true;
        window.close();
      }
    } catch(e) {
      // opener not accessible
    }

    if (!sent || !window.closed) {
      window.location.replace(redirectUrl);
    }
  })();
</script>
<p>Redirecting... <a href="${redirectUrl}">Click here if not redirected</a></p>
</body></html>`;
}

export default router;

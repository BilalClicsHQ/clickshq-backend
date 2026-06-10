import { Request, Response, NextFunction } from 'express';
import { getValidToken, TokenError } from '../services/tokenService';
import type { Provider, DecryptedToken } from '../services/tokenService';

// ─── Extend Express Request to carry the integration token ───────────────────
declare global {
  namespace Express {
    interface Request {
      integrationToken?: DecryptedToken;
    }
  }
}

// ─── Middleware Factory ──────────────────────────────────────────────────────
// Usage: router.get('/api/teams/list', requireAuth, requireIntegration('ms_teams'), handler)
//
// On success: req.integrationToken is set with a valid (non-expired) decrypted token.
// On failure: returns the correct error response — never passes to the handler.
export function requireIntegration(provider: Provider) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.user as any;
      if (!user?.id) {
        return res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'User not authenticated', retryable: false },
        });
      }

      // getValidToken fetches, checks expiry, refreshes if needed, and returns valid token
      const token = await getValidToken(user.id, provider);
      req.integrationToken = token;
      return next();
    } catch (err: any) {
      if (err instanceof TokenError) {
        const statusMap: Record<string, number> = {
          USER_NOT_CONNECTED: 403,
          REFRESH_FAILED: 401,
          TOKEN_EXPIRED: 401,
        };
        const status = statusMap[err.code] || 500;
        return res.status(status).json({
          success: false,
          error: { code: err.code, message: err.message, retryable: err.retryable },
        });
      }

      console.error(`Integration middleware error (${provider}):`, err.message);
      return res.status(500).json({
        success: false,
        error: { code: 'INTEGRATION_ERROR', message: 'Failed to validate integration token', retryable: true },
      });
    }
  };
}

import { Request, Response, NextFunction } from "express";
import { db } from "../db";
import { apiKeys, zapierOAuthTokens, users } from "@shared/schema";
import { eq, and } from "drizzle-orm";

export async function apiKeyAuth(req: Request, res: Response, next: NextFunction) {
  // Support both API key and OAuth Bearer token
  const authHeader = req.headers['authorization'] as string;
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const apiKey = (req.headers['x-api-key'] as string) || (req.query.api_key as string);

  // Try OAuth Bearer token first
  if (bearerToken) {
    try {
      const [tokenRecord] = await db
        .select()
        .from(zapierOAuthTokens)
        .where(and(eq(zapierOAuthTokens.accessToken, bearerToken), eq(zapierOAuthTokens.isActive, true)));

      if (tokenRecord) {
        const [user] = await db.select().from(users).where(eq(users.id, tokenRecord.userId));
        if (user) {
          await db.update(zapierOAuthTokens).set({ lastUsedAt: new Date() }).where(eq(zapierOAuthTokens.id, tokenRecord.id));
          (req as any).user = user;
          return next();
        }
      }
    } catch (err) {
      console.error("[apiKeyAuth] Error validating Bearer token:", err);
    }
  }

  // Fall back to API key
  if (!apiKey) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const [keyRecord] = await db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.key, apiKey), eq(apiKeys.isActive, true)));

    if (!keyRecord) {
      return res.status(401).json({ error: 'Invalid or inactive API key' });
    }

    const [user] = await db.select().from(users).where(eq(users.id, keyRecord.userId));

    if (!user) {
      return res.status(401).json({ error: 'User associated with API key not found' });
    }

    await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, keyRecord.id));

    (req as any).user = user;
    next();
  } catch (err) {
    console.error("[apiKeyAuth] Error validating API key:", err);
    return res.status(500).json({ error: 'Internal server error during authentication' });
  }
}

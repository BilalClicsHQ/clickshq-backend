import { Router, Request, Response } from 'express';
import { eq, and } from 'drizzle-orm';
import { requireAuth } from '../auth';
import { db } from '../db';
import { userIntegrationSettings } from '@shared/schema';

const router = Router();

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/integrations/settings/:provider
// Returns all settings for the current user + provider as a key/value map.
// Response: { success: true, data: { personal_connected_search: false, ... } }
// ═══════════════════════════════════════════════════════════════════════════════
router.get('/:provider', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const { provider } = req.params;

    const rows = await db
      .select()
      .from(userIntegrationSettings)
      .where(
        and(
          eq(userIntegrationSettings.userId, user.id),
          eq(userIntegrationSettings.provider, provider)
        )
      );

    // Convert rows to { settingKey: enabled } map
    const settings: Record<string, boolean> = {};
    for (const row of rows) {
      settings[row.settingKey] = row.enabled ?? false;
    }

    return res.json({ success: true, data: settings });
  } catch (err: any) {
    console.error('Integration settings GET error:', err.message);
    return res.status(500).json({
      success: false,
      error: { code: 'FETCH_FAILED', message: err.message },
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/integrations/settings/:provider
// Upserts a single setting for the current user.
// Body: { settingKey: 'personal_connected_search', enabled: true/false }
// ═══════════════════════════════════════════════════════════════════════════════
router.post('/:provider', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const { provider } = req.params;
    const { settingKey, enabled } = req.body;

    if (!settingKey || typeof enabled !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_REQUEST', message: 'settingKey (string) and enabled (boolean) are required' },
      });
    }

    // Upsert: insert or update on conflict
    await db
      .insert(userIntegrationSettings)
      .values({
        userId: user.id,
        provider,
        settingKey,
        enabled,
      })
      .onConflictDoUpdate({
        target: [
          userIntegrationSettings.userId,
          userIntegrationSettings.provider,
          userIntegrationSettings.settingKey,
        ],
        set: {
          enabled,
          updatedAt: new Date(),
        },
      });

    return res.json({ success: true });
  } catch (err: any) {
    console.error('Integration settings POST error:', err.message);
    return res.status(500).json({
      success: false,
      error: { code: 'UPDATE_FAILED', message: err.message },
    });
  }
});

export default router;

import { Router, Request, Response } from "express";
import { requireAuth } from "../auth";
import {
  getUserNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  deleteNotification,
  notifyMany,
} from "../services/notificationService";

const router = Router();

// POST /api/notifications/mention — notify a list of users who were @mentioned
// somewhere (task description, doc, etc.).
// Body: { userIds: string[], source: string, title?: string, message?: string, link?: string }
router.post("/mention", requireAuth, async (req: Request, res: Response) => {
  try {
    const actorId = (req.user as any)?.id;
    const { userIds, source, title, message, link, metadata } = req.body ?? {};

    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ success: false, error: "userIds (string[]) is required" });
    }
    if (typeof source !== "string" || !source.trim()) {
      return res.status(400).json({ success: false, error: "source (string) is required" });
    }

    // Don't notify the mentioner themselves
    const recipients = userIds.filter((id) => typeof id === "string" && id && id !== actorId);
    if (recipients.length === 0) {
      return res.json({ success: true, notified: 0 });
    }

    await notifyMany(recipients, {
      type: "mention",
      title: typeof title === "string" && title.trim() ? title : "You were mentioned",
      message: typeof message === "string" ? message : "",
      link: typeof link === "string" ? link : "",
      metadata: { source, actorId, ...(metadata && typeof metadata === "object" ? metadata : {}) },
    });

    return res.json({ success: true, notified: recipients.length });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// GET /api/notifications — fetch user's notifications
router.get("/", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req.user as any)?.id;
    if (!userId) return res.status(401).json({ success: false, error: "Not authenticated" });

    const items = await getUserNotifications(userId, 50);
    res.json({ success: true, notifications: items });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// GET /api/notifications/unread — get unread count (for badge)
router.get("/unread", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req.user as any)?.id;
    if (!userId) return res.status(401).json({ success: false, error: "Not authenticated" });

    const count = await getUnreadCount(userId);
    res.json({ success: true, count });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// PATCH /api/notifications/:id/read — mark one as read
router.patch("/:id/read", requireAuth, async (req: Request, res: Response) => {
  try {
    await markAsRead(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// POST /api/notifications/read-all — mark all as read
router.post("/read-all", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req.user as any)?.id;
    if (!userId) return res.status(401).json({ success: false, error: "Not authenticated" });

    await markAllAsRead(userId);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// DELETE /api/notifications/:id — delete notification
router.delete("/:id", requireAuth, async (req: Request, res: Response) => {
  try {
    await deleteNotification(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

export default router;

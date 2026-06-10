import { db } from "../db";
import { notifications } from "@shared/schema";
import { eq, and, desc } from "drizzle-orm";

// ── Reusable notification creator — call from ANYWHERE ──────────────────────

interface NotifyParams {
  userId: string;
  type: string;
  title: string;
  message?: string;
  link?: string;
  metadata?: Record<string, any>;
}

export async function notify(params: NotifyParams): Promise<void> {
  try {
    await db.insert(notifications).values({
      userId: params.userId,
      type: params.type,
      title: params.title,
      message: params.message || "",
      link: params.link || "",
      isRead: false,
      metadata: params.metadata || {},
    });
  } catch (err) {
    console.error("[Notification] Failed to create:", err);
  }
}

// ── Bulk notify — send same notification to multiple users ──────────────────

export async function notifyMany(userIds: string[], params: Omit<NotifyParams, "userId">): Promise<void> {
  for (const userId of userIds) {
    await notify({ ...params, userId });
  }
}

// ── Fetch notifications for a user ──────────────────────────────────────────

export async function getUserNotifications(userId: string, limit = 50) {
  return db.select()
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.createdAt))
    .limit(limit);
}

// ── Get unread count ────────────────────────────────────────────────────────

export async function getUnreadCount(userId: string): Promise<number> {
  const result = await db.select()
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.isRead, false)));
  return result.length;
}

// ── Mark as read ────────────────────────────────────────────────────────────

export async function markAsRead(notificationId: string): Promise<void> {
  await db.update(notifications)
    .set({ isRead: true })
    .where(eq(notifications.id, notificationId));
}

export async function markAllAsRead(userId: string): Promise<void> {
  await db.update(notifications)
    .set({ isRead: true })
    .where(and(eq(notifications.userId, userId), eq(notifications.isRead, false)));
}

// ── Delete notification ─────────────────────────────────────────────────────

export async function deleteNotification(notificationId: string): Promise<void> {
  await db.delete(notifications).where(eq(notifications.id, notificationId));
}

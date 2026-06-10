import { db } from "../db";
import { zapierWebhooks } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";

const LOG_PREFIX = "[Zapier]";

/**
 * Fire a webhook for a specific user.
 * Sends an HTTP POST with JSON payload to the user's registered webhook URL.
 * Never throws — all errors are caught and logged.
 */
export async function fireWebhook(
  userId: string,
  event: string,
  payload: Record<string, any>
): Promise<void> {
  try {
    const [webhook] = await db
      .select()
      .from(zapierWebhooks)
      .where(and(eq(zapierWebhooks.userId, userId), eq(zapierWebhooks.isActive, true)));

    if (!webhook) return;

    // Check if user has this event enabled
    if (webhook.events && !webhook.events.includes(event)) return;

    const body = JSON.stringify({
      event,
      timestamp: new Date().toISOString(),
      data: payload,
    });

    const response = await fetch(webhook.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(10000), // 10s timeout
    });

    if (!response.ok) {
      console.error(
        `${LOG_PREFIX} Webhook failed for user ${userId}: ${response.status} ${response.statusText}`
      );
    }

    // Update lastTriggeredAt
    await db
      .update(zapierWebhooks)
      .set({ lastTriggeredAt: new Date(), updatedAt: new Date() })
      .where(eq(zapierWebhooks.id, webhook.id));
  } catch (err) {
    console.error(`${LOG_PREFIX} Error firing webhook for user ${userId}:`, err);
  }
}

/**
 * Fire webhooks for ALL users that have the given event enabled.
 * Useful for broadcasting events (e.g., task.created) to all connected Zapier users.
 * Never throws — all errors are caught and logged.
 */
export async function fireWebhookForAllUsers(
  event: string,
  payload: Record<string, any>
): Promise<void> {
  try {
    const webhooks = await db
      .select()
      .from(zapierWebhooks)
      .where(eq(zapierWebhooks.isActive, true));

    const body = JSON.stringify({
      event,
      timestamp: new Date().toISOString(),
      data: payload,
    });

    for (const webhook of webhooks) {
      // Check if this webhook has the event enabled
      if (webhook.events && !webhook.events.includes(event)) continue;

      try {
        const response = await fetch(webhook.webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: AbortSignal.timeout(10000),
        });

        if (!response.ok) {
          console.error(
            `${LOG_PREFIX} Webhook failed for user ${webhook.userId}: ${response.status} ${response.statusText}`
          );
        }

        // Update lastTriggeredAt
        await db
          .update(zapierWebhooks)
          .set({ lastTriggeredAt: new Date(), updatedAt: new Date() })
          .where(eq(zapierWebhooks.id, webhook.id));
      } catch (err) {
        console.error(
          `${LOG_PREFIX} Error firing webhook for user ${webhook.userId}:`,
          err
        );
      }
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} Error in fireWebhookForAllUsers:`, err);
  }
}

/**
 * Send a test payload to a webhook URL to verify it works.
 * Returns { success, statusCode, error }.
 */
export async function testWebhook(
  webhookUrl: string
): Promise<{ success: boolean; statusCode?: number; error?: string }> {
  try {
    const body = JSON.stringify({
      event: "test",
      timestamp: new Date().toISOString(),
      data: {
        message: "This is a test webhook from Nexustrack",
        task: {
          id: "test-task-id",
          name: "Sample Task",
          status: "In Progress",
          assignee: "Test User",
        },
      },
    });

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(10000),
    });

    if (response.ok) {
      return { success: true, statusCode: response.status };
    }

    return {
      success: false,
      statusCode: response.status,
      error: `Webhook returned ${response.status} ${response.statusText}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${LOG_PREFIX} Test webhook failed:`, message);
    return { success: false, error: message };
  }
}

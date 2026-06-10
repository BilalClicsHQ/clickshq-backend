/**
 * MS Teams notification service — sends adaptive cards to user's chats/channels.
 *
 * Pattern mirrors slackNotificationService:
 *   - User connects MS Teams via OAuth
 *   - When task events occur (created, assigned, status changed), we send
 *     adaptive cards to the connected user's primary chat with the bot.
 */
import { getValidToken } from "./tokenService";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

async function graph(token: string, endpoint: string, options: RequestInit = {}) {
  const res = await fetch(`${GRAPH_BASE}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any).error?.message || `Teams API error: ${res.status}`);
  }
  if (res.status === 204) return null;
  return await res.json();
}

/**
 * Send a notification message to the user's MS Teams.
 * Tries chats first; falls back gracefully on missing chat.
 */
export async function sendTeamsNotification(
  userId: string,
  params: {
    title: string;
    body: string;
    link?: string;
    taskName?: string;
    actionLabel?: string;
  },
): Promise<void> {
  let token;
  try {
    token = await getValidToken(userId, "ms_teams");
  } catch {
    return; // User hasn't connected Teams — skip silently
  }

  try {
    // Get user's chats to find the primary chat
    const chats: any = await graph(token.accessToken, "/me/chats?$top=10");
    const oneOnOne = chats.value?.find((c: any) => c.chatType === "oneOnOne");
    const chatId = oneOnOne?.id || chats.value?.[0]?.id;
    if (!chatId) return; // No chat available

    // Send adaptive card
    const card = {
      type: "AdaptiveCard",
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      version: "1.4",
      body: [
        {
          type: "TextBlock",
          text: params.title,
          weight: "Bolder",
          size: "Medium",
          wrap: true,
        },
        {
          type: "TextBlock",
          text: params.body,
          wrap: true,
          spacing: "Small",
        },
        ...(params.taskName
          ? [{ type: "TextBlock", text: `Task: ${params.taskName}`, isSubtle: true, spacing: "Small" }]
          : []),
      ],
      actions: params.link
        ? [
            {
              type: "Action.OpenUrl",
              title: params.actionLabel ?? "View in clicsHQ",
              url: params.link,
            },
          ]
        : [],
    };

    await graph(token.accessToken, `/chats/${chatId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        body: { contentType: "html", content: `<p>${params.title}</p>` },
        attachments: [
          {
            id: "1",
            contentType: "application/vnd.microsoft.card.adaptive",
            content: JSON.stringify(card),
          },
        ],
      }),
    });
  } catch (err: any) {
    console.error("[MS Teams Notify] Failed:", err.message);
  }
}

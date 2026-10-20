/**
 * AI utilities for the doc editor.
 *
 *   POST /api/ai/writing-assist  { action, text }                       → rewrite
 *   POST /api/ai/chat            { message, history?, docTitle?, docContent? } → conversational reply
 */
import { Router, Request, Response } from "express";
import { requireAuth } from "../auth";
import {
  runWritingAssist,
  runDocChat,
  runDocGeneration,
  runDocEdit,
  type WritingAction,
  type ChatMessage,
} from "../services/writingAssistService";
import { db } from "../db";
import { aiConversations, aiMessages } from "@shared/schema";
import { eq, and, desc, asc } from "drizzle-orm";

const router = Router();

const VALID_ACTIONS: WritingAction[] = [
  "improve",
  "grammar",
  "longer",
  "shorter",
  "explain",
  "summarize",
];

router.post("/writing-assist", requireAuth, async (req: Request, res: Response) => {
  const { action, text } = req.body ?? {};

  if (!action || !VALID_ACTIONS.includes(action as WritingAction)) {
    return res
      .status(400)
      .json({ success: false, error: `Invalid action. Expected one of: ${VALID_ACTIONS.join(", ")}` });
  }
  if (typeof text !== "string") {
    return res.status(400).json({ success: false, error: "text (string) is required" });
  }

  const result = await runWritingAssist(action as WritingAction, text);
  if (!result.success) {
    return res.status(500).json(result);
  }
  return res.json(result);
});

router.post("/chat", requireAuth, async (req: Request, res: Response) => {
  const { message, history, docTitle, docContent } = req.body ?? {};

  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ success: false, error: "message (string) is required" });
  }

  const safeHistory: ChatMessage[] = Array.isArray(history)
    ? history.filter(
        (m: any): m is ChatMessage =>
          m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string",
      )
    : [];

  const result = await runDocChat(message, safeHistory, {
    docTitle: typeof docTitle === "string" ? docTitle : undefined,
    docContent: typeof docContent === "string" ? docContent : undefined,
  });
  if (!result.success) {
    return res.status(500).json(result);
  }
  return res.json(result);
});

router.post("/generate-doc", requireAuth, async (req: Request, res: Response) => {
  const { prompt } = req.body ?? {};

  if (typeof prompt !== "string" || !prompt.trim()) {
    return res.status(400).json({ success: false, error: "prompt (string) is required" });
  }

  const result = await runDocGeneration(prompt);
  if (!result.success) {
    return res.status(500).json(result);
  }
  return res.json(result);
});

router.post("/edit-doc", requireAuth, async (req: Request, res: Response) => {
  const { instruction, content } = req.body ?? {};

  if (typeof instruction !== "string" || !instruction.trim()) {
    return res.status(400).json({ success: false, error: "instruction (string) is required" });
  }

  const result = await runDocEdit(instruction, typeof content === "string" ? content : "");
  if (!result.success) {
    return res.status(500).json(result);
  }
  return res.json(result);
});

// ─── Conversations (Clics AI chat history) ──────────────────────────────────

// List the current user's conversations (most recent first).
router.get("/conversations", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req.user as any)?.id;
    if (!userId) return res.status(401).json({ success: false, error: "Authentication required" });
    const rows = await db
      .select()
      .from(aiConversations)
      .where(eq(aiConversations.userId, userId))
      .orderBy(desc(aiConversations.updatedAt));
    return res.json({ success: true, conversations: rows });
  } catch (err: any) {
    console.error("Error listing conversations:", err);
    return res.status(500).json({ success: false, error: "Failed to load conversations" });
  }
});

// Create a new (empty) conversation.
router.post("/conversations", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req.user as any)?.id;
    if (!userId) return res.status(401).json({ success: false, error: "Authentication required" });
    const [conversation] = await db
      .insert(aiConversations)
      .values({ userId, title: "New chat" })
      .returning();
    return res.status(201).json({ success: true, conversation });
  } catch (err: any) {
    console.error("Error creating conversation:", err);
    return res.status(500).json({ success: false, error: "Failed to create conversation" });
  }
});

// Delete a conversation (and its messages).
router.delete("/conversations/:id", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req.user as any)?.id;
    if (!userId) return res.status(401).json({ success: false, error: "Authentication required" });
    const [conv] = await db
      .select()
      .from(aiConversations)
      .where(and(eq(aiConversations.id, req.params.id), eq(aiConversations.userId, userId)));
    if (!conv) return res.status(404).json({ success: false, error: "Conversation not found" });
    await db.delete(aiMessages).where(eq(aiMessages.conversationId, conv.id));
    await db.delete(aiConversations).where(eq(aiConversations.id, conv.id));
    return res.json({ success: true });
  } catch (err: any) {
    console.error("Error deleting conversation:", err);
    return res.status(500).json({ success: false, error: "Failed to delete conversation" });
  }
});

// Get all messages in a conversation.
router.get("/conversations/:id/messages", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req.user as any)?.id;
    if (!userId) return res.status(401).json({ success: false, error: "Authentication required" });
    const [conv] = await db
      .select()
      .from(aiConversations)
      .where(and(eq(aiConversations.id, req.params.id), eq(aiConversations.userId, userId)));
    if (!conv) return res.status(404).json({ success: false, error: "Conversation not found" });
    const rows = await db
      .select()
      .from(aiMessages)
      .where(eq(aiMessages.conversationId, conv.id))
      .orderBy(asc(aiMessages.createdAt));
    return res.json({ success: true, messages: rows });
  } catch (err: any) {
    console.error("Error loading messages:", err);
    return res.status(500).json({ success: false, error: "Failed to load messages" });
  }
});

// Send a message in a conversation: persist the user turn, generate an AI reply
// via Groq (with prior history), persist the reply, and return both.
router.post("/conversations/:id/messages", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req.user as any)?.id;
    if (!userId) return res.status(401).json({ success: false, error: "Authentication required" });
    const { message, attachmentText, attachmentName } = req.body ?? {};
    if (typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ success: false, error: "message (string) is required" });
    }

    const [conv] = await db
      .select()
      .from(aiConversations)
      .where(and(eq(aiConversations.id, req.params.id), eq(aiConversations.userId, userId)));
    if (!conv) return res.status(404).json({ success: false, error: "Conversation not found" });

    // Prior turns for context.
    const prior = await db
      .select()
      .from(aiMessages)
      .where(eq(aiMessages.conversationId, conv.id))
      .orderBy(asc(aiMessages.createdAt));
    const history: ChatMessage[] = prior.map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    }));

    // If a file was attached, note it in the saved user message (for history) and
    // pass its extracted text to the model as context for this turn.
    const hasAttachment = typeof attachmentText === "string" && attachmentText.trim().length > 0;
    const savedContent =
      hasAttachment && typeof attachmentName === "string" && attachmentName.trim()
        ? `📎 ${attachmentName.trim()}\n\n${message.trim()}`
        : message.trim();

    // Save the user message.
    const [userMessage] = await db
      .insert(aiMessages)
      .values({ conversationId: conv.id, role: "user", content: savedContent })
      .returning();

    // Generate the AI reply (Groq) — attachment goes in as doc context.
    const result = await runDocChat(message.trim(), history, {
      docTitle: hasAttachment && typeof attachmentName === "string" ? attachmentName : undefined,
      docContent: hasAttachment ? attachmentText : undefined,
    });
    if (!result.success) {
      return res.status(500).json(result);
    }

    const [assistantMessage] = await db
      .insert(aiMessages)
      .values({ conversationId: conv.id, role: "assistant", content: result.reply })
      .returning();

    // Title the conversation from the first user message; always bump updatedAt.
    const newTitle =
      conv.title === "New chat" ? message.trim().slice(0, 60) : conv.title;
    await db
      .update(aiConversations)
      .set({ title: newTitle, updatedAt: new Date() })
      .where(eq(aiConversations.id, conv.id));

    return res.json({ success: true, reply: result.reply, userMessage, assistantMessage, title: newTitle });
  } catch (err: any) {
    console.error("Error sending message:", err);
    return res.status(500).json({ success: false, error: "Failed to send message" });
  }
});

export default router;

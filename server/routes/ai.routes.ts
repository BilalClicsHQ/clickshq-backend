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
  type WritingAction,
  type ChatMessage,
} from "../services/writingAssistService";

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

export default router;

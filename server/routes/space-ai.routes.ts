/**
 * Space AI insights + space chat (space page → "AI insights" tab).
 * Mounted at /api/spaces/:spaceId/ai
 *
 *   GET  /insights                          six insight cards (generates missing ones)
 *   POST /insights/:cardKey/regenerate      regenerate one card
 *   PUT  /insights/:cardKey/prompt          { prompt } save a custom prompt + regenerate
 *   PUT  /insights/:cardKey/feedback        { value: "up" | "down" | null }
 *   GET  /chat/conversations                this space's chats for the current user
 *   POST /chat                              { conversationId?, message } → { conversationId, reply }
 *
 * Messages of a chat are read with GET /api/ai/conversations/:id/messages.
 */
import { Router, Request, Response, NextFunction } from "express";
import { requireAuth } from "../auth";
import { requireFeature } from "../middleware/requireEntitlement";
import { AgentError, type AgentUser } from "../services/aiAgentService";
import { describeOpenAIError, isOpenAIConfigured } from "../services/openaiService";
import {
  getSpaceInsights,
  listSpaceConversations,
  regenerateInsight,
  setInsightFeedback,
  setInsightPrompt,
  spaceChatReply,
} from "../services/spaceInsightsService";

const router = Router({ mergeParams: true });

const agentUser = (req: Request): AgentUser => {
  const user = req.user as any;
  return { id: user?.id, companyId: user?.companyId ?? null };
};

function sendError(res: Response, err: unknown, label: string) {
  if (err instanceof AgentError) {
    return res.status(err.status).json({ success: false, error: err.message });
  }
  console.error(`[Space AI] ${label} failed:`, err instanceof Error ? err.message : err);
  return res.status(500).json({ success: false, error: describeOpenAIError(err) });
}

const requireOpenAI = (_req: Request, res: Response, next: NextFunction) => {
  if (!isOpenAIConfigured()) {
    return res.status(503).json({ success: false, error: "AI not configured (OPENAI_API_KEY missing)" });
  }
  next();
};

router.use(requireAuth, requireFeature("ai_insights"));

router.get("/insights", requireOpenAI, async (req: Request, res: Response) => {
  try {
    const cards = await getSpaceInsights(agentUser(req), req.params.spaceId);
    res.json({ success: true, data: { cards } });
  } catch (err) {
    sendError(res, err, "insights");
  }
});

router.post("/insights/:cardKey/regenerate", requireOpenAI, async (req: Request, res: Response) => {
  try {
    const data = await regenerateInsight(agentUser(req), req.params.spaceId, req.params.cardKey);
    res.json({ success: true, data });
  } catch (err) {
    sendError(res, err, "regenerate");
  }
});

router.put("/insights/:cardKey/prompt", requireOpenAI, async (req: Request, res: Response) => {
  try {
    const data = await setInsightPrompt(agentUser(req), req.params.spaceId, req.params.cardKey, req.body?.prompt);
    res.json({ success: true, data });
  } catch (err) {
    sendError(res, err, "prompt");
  }
});

router.put("/insights/:cardKey/feedback", async (req: Request, res: Response) => {
  try {
    const data = await setInsightFeedback(agentUser(req), req.params.spaceId, req.params.cardKey, req.body?.value);
    res.json({ success: true, data });
  } catch (err) {
    sendError(res, err, "feedback");
  }
});

router.get("/chat/conversations", async (req: Request, res: Response) => {
  try {
    const conversations = await listSpaceConversations(agentUser(req), req.params.spaceId);
    res.json({ success: true, data: { conversations } });
  } catch (err) {
    sendError(res, err, "chat list");
  }
});

router.post("/chat", requireOpenAI, async (req: Request, res: Response) => {
  try {
    const data = await spaceChatReply(agentUser(req), req.params.spaceId, req.body?.conversationId, req.body?.message);
    res.json({ success: true, data });
  } catch (err) {
    sendError(res, err, "chat");
  }
});

export default router;

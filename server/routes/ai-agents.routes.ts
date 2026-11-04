/**
 * AI Agents API.
 *
 *   POST /api/ai-agents/:agentId/preview   { ...input }    → LLM result to review (no changes)
 *   POST /api/ai-agents/:agentId/apply     { ...preview }  → perform the confirmed actions
 *   POST /api/ai-agents/follow-up-agent/run                 → run the Follow-up Agent now
 */
import { Router, Request, Response } from "express";
import { requireAuth } from "../auth";
import { AgentError, applyAgent, previewAgent, runFollowUpAgent, type AgentUser } from "../services/aiAgentService";
import { describeOpenAIError, isOpenAIConfigured } from "../services/openaiService";

const router = Router();

const agentUser = (req: Request): AgentUser => {
  const user = req.user as any;
  return { id: user?.id, companyId: user?.companyId ?? null };
};

function sendError(res: Response, err: unknown, label: string) {
  if (err instanceof AgentError) {
    return res.status(err.status).json({ success: false, error: err.message });
  }
  console.error(`[AI Agents] ${label} failed:`, err instanceof Error ? err.message : err);
  return res.status(500).json({ success: false, error: describeOpenAIError(err) });
}

const requireOpenAI = (_req: Request, res: Response, next: () => void) => {
  if (!isOpenAIConfigured()) {
    return res.status(503).json({ success: false, error: "AI not configured (OPENAI_API_KEY missing)" });
  }
  next();
};

router.post("/follow-up-agent/run", requireAuth, requireOpenAI, async (req: Request, res: Response) => {
  try {
    const reminders = await runFollowUpAgent({ user: agentUser(req) });
    res.json({ success: true, data: { reminders } });
  } catch (err) {
    sendError(res, err, "follow-up run");
  }
});

router.post("/:agentId/preview", requireAuth, requireOpenAI, async (req: Request, res: Response) => {
  try {
    const data = await previewAgent(req.params.agentId, agentUser(req), req.body);
    res.json({ success: true, data });
  } catch (err) {
    sendError(res, err, `${req.params.agentId} preview`);
  }
});

router.post("/:agentId/apply", requireAuth, async (req: Request, res: Response) => {
  try {
    const data = await applyAgent(req.params.agentId, agentUser(req), req.body);
    res.json({ success: true, data });
  } catch (err) {
    sendError(res, err, `${req.params.agentId} apply`);
  }
});

export default router;

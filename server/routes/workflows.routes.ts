import { Router, Request, Response } from "express";
import { requireAuth } from "../auth";
import { storage } from "../storage";

const router = Router();

// ── Validation helper ───────────────────────────────────────────────────────
function validateWorkflowForLive(steps: any[]): string | null {
  if (!steps || !Array.isArray(steps) || steps.length === 0) {
    return "Workflow must have at least one step";
  }

  const triggerTypes = ["when", "trigger"];
  const actionTypes = ["then", "action"];

  const hasTrigger = steps.some((s) => triggerTypes.includes(s.type) && s.label);
  if (!hasTrigger) return "Workflow must have at least one configured trigger";

  const hasAction = steps.some((s) => actionTypes.includes(s.type) && s.label);
  if (!hasAction) return "Workflow must have at least one configured action";

  return null; // valid
}

// ── List user's workflows ────────────────────────────────────────────────────
router.get("/", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req.user as any)?.id;
    if (!userId) return res.status(401).json({ success: false, error: "Not authenticated" });

    const workflows = await storage.getWorkflowsByOwner(userId);
    res.json({ success: true, workflows });
  } catch (error) {
    console.error("Error listing workflows:", error);
    res.status(500).json({ success: false, error: String(error) });
  }
});

// ── Get single workflow ──────────────────────────────────────────────────────
router.get("/:id", requireAuth, async (req: Request, res: Response) => {
  try {
    const workflow = await storage.getWorkflow(req.params.id);
    if (!workflow) return res.status(404).json({ success: false, error: "Workflow not found" });
    res.json({ success: true, workflow });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// ── Create workflow ──────────────────────────────────────────────────────────
router.post("/", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req.user as any)?.id;
    if (!userId) return res.status(401).json({ success: false, error: "Not authenticated" });

    const { name, status, steps, isFavorite } = req.body;
    if (!name) return res.status(400).json({ success: false, error: "Name is required" });

    // Validate before going live
    if (status === "live") {
      const validationError = validateWorkflowForLive(steps);
      if (validationError) {
        return res.status(400).json({ success: false, error: validationError });
      }
    }

    const workflow = await storage.createWorkflow({
      name,
      status: status || "draft",
      ownerId: userId,
      steps: steps || [],
      isFavorite: isFavorite || false,
    });

    res.status(201).json({ success: true, workflow });
  } catch (error) {
    console.error("Error creating workflow:", error);
    res.status(500).json({ success: false, error: String(error) });
  }
});

// ── Update workflow ──────────────────────────────────────────────────────────
router.patch("/:id", requireAuth, async (req: Request, res: Response) => {
  try {
    const { name, status, steps, isFavorite } = req.body;
    const updates: any = {};
    if (name !== undefined) updates.name = name;
    if (status !== undefined) updates.status = status;
    if (steps !== undefined) updates.steps = steps;
    if (isFavorite !== undefined) updates.isFavorite = isFavorite;

    // Validate before going live
    if (status === "live") {
      const stepsToValidate = steps || (await storage.getWorkflow(req.params.id))?.steps || [];
      const validationError = validateWorkflowForLive(stepsToValidate as any[]);
      if (validationError) {
        return res.status(400).json({ success: false, error: validationError });
      }
    }

    if (status === "live") updates.lastPublished = new Date();

    const workflow = await storage.updateWorkflow(req.params.id, updates);
    if (!workflow) return res.status(404).json({ success: false, error: "Workflow not found" });

    res.json({ success: true, workflow });
  } catch (error) {
    console.error("Error updating workflow:", error);
    res.status(500).json({ success: false, error: String(error) });
  }
});

// ── Delete workflow ──────────────────────────────────────────────────────────
router.delete("/:id", requireAuth, async (req: Request, res: Response) => {
  try {
    const success = await storage.deleteWorkflow(req.params.id);
    if (!success) return res.status(404).json({ success: false, error: "Workflow not found" });
    res.json({ success: true });
  } catch (error) {
    console.error("Error deleting workflow:", error);
    res.status(500).json({ success: false, error: String(error) });
  }
});

// ── Toggle status (live <-> paused) ──────────────────────────────────────────
router.post("/:id/toggle", requireAuth, async (req: Request, res: Response) => {
  try {
    const workflow = await storage.getWorkflow(req.params.id);
    if (!workflow) return res.status(404).json({ success: false, error: "Workflow not found" });

    const newStatus = workflow.status === "live" ? "paused" : "live";

    // Validate before going live
    if (newStatus === "live") {
      const validationError = validateWorkflowForLive((workflow.steps as any[]) || []);
      if (validationError) {
        return res.status(400).json({ success: false, error: validationError });
      }
    }

    const updates: any = { status: newStatus };
    if (newStatus === "live") {
      updates.lastPublished = new Date();
    }

    const updated = await storage.updateWorkflow(req.params.id, updates);
    res.json({ success: true, workflow: updated });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// ── Duplicate workflow ───────────────────────────────────────────────────────
router.post("/:id/duplicate", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req.user as any)?.id;
    const original = await storage.getWorkflow(req.params.id);
    if (!original) return res.status(404).json({ success: false, error: "Workflow not found" });

    const duplicate = await storage.createWorkflow({
      name: `${original.name} (Copy)`,
      status: "draft",
      ownerId: userId,
      steps: original.steps as any,
      isFavorite: false,
    });

    res.status(201).json({ success: true, workflow: duplicate });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// ── Toggle favorite ──────────────────────────────────────────────────────────
router.post("/:id/favorite", requireAuth, async (req: Request, res: Response) => {
  try {
    const workflow = await storage.getWorkflow(req.params.id);
    if (!workflow) return res.status(404).json({ success: false, error: "Workflow not found" });

    const updated = await storage.updateWorkflow(req.params.id, {
      isFavorite: !workflow.isFavorite,
    });
    res.json({ success: true, workflow: updated });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// ── Get workflow execution logs ──────────────────────────────────────────────
router.get("/:id/logs", requireAuth, async (req: Request, res: Response) => {
  try {
    const workflow = await storage.getWorkflow(req.params.id);
    if (!workflow) return res.status(404).json({ success: false, error: "Workflow not found" });

    const logs = await storage.getWorkflowLogs(req.params.id);
    res.json({ success: true, logs });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

export default router;

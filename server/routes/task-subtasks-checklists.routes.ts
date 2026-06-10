/**
 * Subtasks and Checklists for a task.
 *
 * Mounted at /api/tasks.
 *
 *   Subtasks:
 *     GET    /:taskId/subtasks
 *     POST   /:taskId/subtasks            { name, priority?, assigneeId?, dueDate? }
 *     PATCH  /subtasks/:id                { name?, completed?, priority?, assigneeId?, dueDate?, order? }
 *     DELETE /subtasks/:id
 *
 *   Checklists:
 *     GET    /:taskId/checklists          (returns each with embedded items[])
 *     POST   /:taskId/checklists          { name? }
 *     PATCH  /checklists/:id              { name?, order? }
 *     DELETE /checklists/:id
 *
 *     POST   /checklists/:checklistId/items   { text }
 *     PATCH  /checklist-items/:id             { text?, completed?, assigneeId?, order? }
 *     DELETE /checklist-items/:id
 */
import { Router, Request, Response } from "express";
import { requireAuth } from "../auth";
import { storage } from "../storage";

const router = Router();

// ── Subtasks ────────────────────────────────────────────────────────────────

router.get("/:taskId/subtasks", requireAuth, async (req: Request, res: Response) => {
  try {
    const { taskId } = req.params;
    const data = await storage.getTaskSubtasks(taskId);
    return res.json({ success: true, data });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: "INTERNAL", message: err.message } });
  }
});

router.post("/:taskId/subtasks", requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const { taskId } = req.params;
    const { name, priority, assigneeId, dueDate } = req.body ?? {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, error: { code: "MISSING_NAME" } });
    }
    const created = await storage.createTaskSubtask({
      taskId,
      name: String(name).trim(),
      priority: priority ?? null,
      assigneeId: assigneeId ?? null,
      dueDate: dueDate ?? null,
      completed: false,
      order: 0,
      createdBy: user.id,
    });
    return res.json({ success: true, data: created });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: "INTERNAL", message: err.message } });
  }
});

router.patch("/subtasks/:id", requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const updates = req.body ?? {};
    const updated = await storage.updateTaskSubtask(id, updates);
    return res.json({ success: true, data: updated });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: "INTERNAL", message: err.message } });
  }
});

router.delete("/subtasks/:id", requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const ok = await storage.deleteTaskSubtask(id);
    return res.json({ success: ok });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: "INTERNAL", message: err.message } });
  }
});

// ── Checklists (with embedded items) ────────────────────────────────────────

router.get("/:taskId/checklists", requireAuth, async (req: Request, res: Response) => {
  try {
    const { taskId } = req.params;
    const lists = await storage.getTaskChecklists(taskId);
    // Hydrate items per list — small N expected so sequential is fine
    const withItems = await Promise.all(
      lists.map(async (l) => ({
        ...l,
        items: await storage.getTaskChecklistItems(l.id),
      })),
    );
    return res.json({ success: true, data: withItems });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: "INTERNAL", message: err.message } });
  }
});

router.post("/:taskId/checklists", requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const { taskId } = req.params;
    const { name } = req.body ?? {};
    const created = await storage.createTaskChecklist({
      taskId,
      name: name ?? "Checklist",
      order: 0,
      createdBy: user.id,
    });
    return res.json({ success: true, data: { ...created, items: [] } });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: "INTERNAL", message: err.message } });
  }
});

router.patch("/checklists/:id", requireAuth, async (req: Request, res: Response) => {
  try {
    const updated = await storage.updateTaskChecklist(req.params.id, req.body ?? {});
    return res.json({ success: true, data: updated });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: "INTERNAL", message: err.message } });
  }
});

router.delete("/checklists/:id", requireAuth, async (req: Request, res: Response) => {
  try {
    const ok = await storage.deleteTaskChecklist(req.params.id);
    return res.json({ success: ok });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: "INTERNAL", message: err.message } });
  }
});

// ── Checklist items ─────────────────────────────────────────────────────────

router.post("/checklists/:checklistId/items", requireAuth, async (req: Request, res: Response) => {
  try {
    const { checklistId } = req.params;
    const { text } = req.body ?? {};
    if (!text || !String(text).trim()) {
      return res.status(400).json({ success: false, error: { code: "MISSING_TEXT" } });
    }
    const created = await storage.createTaskChecklistItem({
      checklistId,
      text: String(text).trim(),
      completed: false,
      order: 0,
      assigneeId: null,
    });
    return res.json({ success: true, data: created });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: "INTERNAL", message: err.message } });
  }
});

router.patch("/checklist-items/:id", requireAuth, async (req: Request, res: Response) => {
  try {
    const updated = await storage.updateTaskChecklistItem(req.params.id, req.body ?? {});
    return res.json({ success: true, data: updated });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: "INTERNAL", message: err.message } });
  }
});

router.delete("/checklist-items/:id", requireAuth, async (req: Request, res: Response) => {
  try {
    const ok = await storage.deleteTaskChecklistItem(req.params.id);
    return res.json({ success: ok });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: "INTERNAL", message: err.message } });
  }
});

export default router;

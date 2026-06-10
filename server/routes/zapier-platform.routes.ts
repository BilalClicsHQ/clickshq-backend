import { Router, Request, Response } from "express";
import { db } from "../db";
import { tasks, spaceStatuses, spaces, users } from "@shared/schema";
import { eq, desc, gte, like, sql } from "drizzle-orm";
import { apiKeyAuth } from "../middleware/apiKeyAuth";

const router = Router();

// All routes use API key authentication
router.use(apiKeyAuth);

// ─── AUTH TEST ────────────────────────────────────────────────────────────────
// GET /me — Zapier calls this to verify the API key works
router.get("/me", async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    res.json({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
    });
  } catch (err) {
    console.error("[Zapier Platform] Error in /me:", err);
    res.status(500).json({ error: "Failed to fetch user info" });
  }
});

// ─── TRIGGERS ─────────────────────────────────────────────────────────────────

// GET /triggers/new-task — recently created tasks (last 24h)
router.get("/triggers/new-task", async (req: Request, res: Response) => {
  try {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const results = await db
      .select({
        id: tasks.id,
        name: tasks.name,
        description: tasks.description,
        priority: tasks.priority,
        dueDate: tasks.dueDate,
        spaceId: tasks.spaceId,
        statusId: tasks.statusId,
        ownerId: tasks.ownerId,
        createdAt: tasks.createdAt,
        updatedAt: tasks.updatedAt,
        statusName: spaceStatuses.name,
        spaceName: spaces.name,
        ownerName: users.displayName,
      })
      .from(tasks)
      .leftJoin(spaceStatuses, eq(tasks.statusId, spaceStatuses.id))
      .leftJoin(spaces, eq(tasks.spaceId, spaces.id))
      .leftJoin(users, eq(tasks.ownerId, users.id))
      .where(gte(tasks.createdAt, twentyFourHoursAgo))
      .orderBy(desc(tasks.createdAt))
      .limit(50);

    const formatted = results.map(r => ({
      id: r.id,
      task: r.name,
      description: r.description,
      status: r.statusName || "Unknown",
      priority: r.priority || "Normal",
      owner: r.ownerName || "Unassigned",
      dueDate: r.dueDate || null,
      space: r.spaceName || "Unknown",
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));

    res.json(formatted);
  } catch (err) {
    console.error("[Zapier Platform] Error in /triggers/new-task:", err);
    res.status(500).json({ error: "Failed to fetch new tasks" });
  }
});

// GET /triggers/task-updated — recently updated tasks (last 24h)
router.get("/triggers/task-updated", async (req: Request, res: Response) => {
  try {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const results = await db
      .select({
        id: tasks.id,
        name: tasks.name,
        description: tasks.description,
        priority: tasks.priority,
        dueDate: tasks.dueDate,
        spaceId: tasks.spaceId,
        statusId: tasks.statusId,
        ownerId: tasks.ownerId,
        createdAt: tasks.createdAt,
        updatedAt: tasks.updatedAt,
        statusName: spaceStatuses.name,
        spaceName: spaces.name,
        ownerName: users.displayName,
      })
      .from(tasks)
      .leftJoin(spaceStatuses, eq(tasks.statusId, spaceStatuses.id))
      .leftJoin(spaces, eq(tasks.spaceId, spaces.id))
      .leftJoin(users, eq(tasks.ownerId, users.id))
      .where(gte(tasks.updatedAt, twentyFourHoursAgo))
      .orderBy(desc(tasks.updatedAt))
      .limit(50);

    const formatted = results.map(r => ({
      id: r.id,
      task: r.name,
      description: r.description,
      status: r.statusName || "Unknown",
      priority: r.priority || "Normal",
      owner: r.ownerName || "Unassigned",
      dueDate: r.dueDate || null,
      space: r.spaceName || "Unknown",
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));

    res.json(formatted);
  } catch (err) {
    console.error("[Zapier Platform] Error in /triggers/task-updated:", err);
    res.status(500).json({ error: "Failed to fetch updated tasks" });
  }
});

// GET /triggers/task-completed — recently completed tasks (last 24h)
router.get("/triggers/task-completed", async (req: Request, res: Response) => {
  try {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Find tasks where status name contains "done" or "complete" (case insensitive)
    const results = await db
      .select({
        id: tasks.id,
        name: tasks.name,
        description: tasks.description,
        priority: tasks.priority,
        dueDate: tasks.dueDate,
        spaceId: tasks.spaceId,
        statusId: tasks.statusId,
        ownerId: tasks.ownerId,
        createdAt: tasks.createdAt,
        updatedAt: tasks.updatedAt,
        statusName: spaceStatuses.name,
        spaceName: spaces.name,
        ownerName: users.displayName,
      })
      .from(tasks)
      .leftJoin(spaceStatuses, eq(tasks.statusId, spaceStatuses.id))
      .leftJoin(spaces, eq(tasks.spaceId, spaces.id))
      .leftJoin(users, eq(tasks.ownerId, users.id))
      .where(
        sql`${tasks.updatedAt} >= ${twentyFourHoursAgo} AND (
          LOWER(${spaceStatuses.name}) LIKE '%done%' OR
          LOWER(${spaceStatuses.name}) LIKE '%complete%' OR
          LOWER(${spaceStatuses.name}) LIKE '%finished%'
        )`
      )
      .orderBy(desc(tasks.updatedAt))
      .limit(50);

    const formatted = results.map(r => ({
      id: r.id,
      task: r.name,
      description: r.description,
      status: r.statusName || "Unknown",
      priority: r.priority || "Normal",
      owner: r.ownerName || "Unassigned",
      dueDate: r.dueDate || null,
      space: r.spaceName || "Unknown",
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));

    res.json(formatted);
  } catch (err) {
    console.error("[Zapier Platform] Error in /triggers/task-completed:", err);
    res.status(500).json({ error: "Failed to fetch completed tasks" });
  }
});

// ─── ACTIONS ──────────────────────────────────────────────────────────────────

// POST /actions/create-task — create a new task in a space
router.post("/actions/create-task", async (req: Request, res: Response) => {
  try {
    const { task, spaceId, statusId, priority, dueDate, description } = req.body;
    const user = req.user as any;

    if (!task || typeof task !== "string") {
      return res.status(400).json({ error: "task (task name) is required" });
    }

    // If no spaceId provided, use the first available space
    let targetSpaceId = spaceId;
    let targetStatusId = statusId;

    if (!targetSpaceId) {
      const [firstSpace] = await db.select().from(spaces).limit(1);
      if (!firstSpace) {
        return res.status(400).json({ error: "No spaces found. Create a space first." });
      }
      targetSpaceId = firstSpace.id;
    }

    // If no statusId provided, use the first status of the space
    if (!targetStatusId) {
      const [firstStatus] = await db
        .select()
        .from(spaceStatuses)
        .where(eq(spaceStatuses.spaceId, targetSpaceId))
        .orderBy(spaceStatuses.order)
        .limit(1);
      if (firstStatus) {
        targetStatusId = firstStatus.id;
      } else {
        return res.status(400).json({ error: "No statuses found for this space." });
      }
    }

    const [created] = await db
      .insert(tasks)
      .values({
        name: task,
        spaceId: targetSpaceId,
        statusId: targetStatusId,
        priority: priority || "Normal",
        ownerId: user.id,
        dueDate: dueDate || null,
        description: description || "",
      })
      .returning();

    // Fetch status and space names for response
    const [statusInfo] = await db.select().from(spaceStatuses).where(eq(spaceStatuses.id, created.statusId));
    const [spaceInfo] = await db.select().from(spaces).where(eq(spaces.id, created.spaceId));

    res.status(201).json({
      id: created.id,
      task: created.name,
      description: created.description,
      status: statusInfo?.name || "Unknown",
      priority: created.priority,
      owner: user.displayName,
      dueDate: created.dueDate,
      space: spaceInfo?.name || "Unknown",
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
    });
  } catch (err) {
    console.error("[Zapier Platform] Error in /actions/create-task:", err);
    res.status(500).json({ error: "Failed to create task" });
  }
});

// POST /actions/update-task — update a task by id
router.post("/actions/update-task", async (req: Request, res: Response) => {
  try {
    const { id, task, statusId, priority, dueDate, description } = req.body;

    if (!id) {
      return res.status(400).json({ error: "id is required" });
    }

    const updateData: Record<string, any> = { updatedAt: new Date() };
    if (task !== undefined) updateData.name = task;
    if (statusId !== undefined) updateData.statusId = statusId;
    if (priority !== undefined) updateData.priority = priority;
    if (dueDate !== undefined) updateData.dueDate = dueDate;
    if (description !== undefined) updateData.description = description;

    const [updated] = await db
      .update(tasks)
      .set(updateData)
      .where(eq(tasks.id, id))
      .returning();

    if (!updated) {
      return res.status(404).json({ error: "Task not found" });
    }

    const [statusInfo] = await db.select().from(spaceStatuses).where(eq(spaceStatuses.id, updated.statusId));
    const [spaceInfo] = await db.select().from(spaces).where(eq(spaces.id, updated.spaceId));
    const [ownerInfo] = await db.select().from(users).where(eq(users.id, updated.ownerId));

    res.json({
      id: updated.id,
      task: updated.name,
      description: updated.description,
      status: statusInfo?.name || "Unknown",
      priority: updated.priority,
      owner: ownerInfo?.displayName || "Unknown",
      dueDate: updated.dueDate,
      space: spaceInfo?.name || "Unknown",
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    });
  } catch (err) {
    console.error("[Zapier Platform] Error in /actions/update-task:", err);
    res.status(500).json({ error: "Failed to update task" });
  }
});

// ─── SEARCH ───────────────────────────────────────────────────────────────────

// GET /search/tasks?query=xxx — search tasks by name
router.get("/search/tasks", async (req: Request, res: Response) => {
  try {
    const query = req.query.query as string;

    if (!query) {
      return res.status(400).json({ error: "query parameter is required" });
    }

    const results = await db
      .select({
        id: tasks.id,
        name: tasks.name,
        description: tasks.description,
        priority: tasks.priority,
        dueDate: tasks.dueDate,
        createdAt: tasks.createdAt,
        statusName: spaceStatuses.name,
        spaceName: spaces.name,
        ownerName: users.displayName,
      })
      .from(tasks)
      .leftJoin(spaceStatuses, eq(tasks.statusId, spaceStatuses.id))
      .leftJoin(spaces, eq(tasks.spaceId, spaces.id))
      .leftJoin(users, eq(tasks.ownerId, users.id))
      .where(like(tasks.name, `%${query}%`))
      .orderBy(desc(tasks.createdAt))
      .limit(25);

    const formatted = results.map(r => ({
      id: r.id,
      task: r.name,
      description: r.description,
      status: r.statusName || "Unknown",
      priority: r.priority || "Normal",
      owner: r.ownerName || "Unassigned",
      dueDate: r.dueDate || null,
      space: r.spaceName || "Unknown",
      createdAt: r.createdAt,
    }));

    res.json(formatted);
  } catch (err) {
    console.error("[Zapier Platform] Error in /search/tasks:", err);
    res.status(500).json({ error: "Failed to search tasks" });
  }
});

export default router;

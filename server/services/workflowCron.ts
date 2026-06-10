import { storage } from "../storage";
import { evaluateWorkflows } from "./workflowEngine";
import { db } from "../db";
import { tasks, workflowLogs } from "@shared/schema";
import { eq, and, lt, gt, isNotNull, sql } from "drizzle-orm";

/**
 * Cron job that checks for time-based workflow triggers:
 * - "Due date is approaching" (due within next 24 hours)
 * - "Task becomes overdue" (due date has passed)
 *
 * Runs every 15 minutes. Uses workflow_logs to avoid duplicate triggers per day.
 */
export async function runWorkflowCron(): Promise<void> {
  try {
    const now = new Date();
    const todayStr = now.toISOString().split("T")[0]; // YYYY-MM-DD

    // ── 1. Due date approaching (within next 24h) ─────────────────────────
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const tomorrowStr = tomorrow.toISOString().split("T")[0];

    const allTasks = await db.select().from(tasks).where(isNotNull(tasks.dueDate));

    // Filter tasks with dueDate approaching (today <= dueDate <= tomorrow)
    const approachingTasks = allTasks.filter((t) => {
      if (!t.dueDate) return false;
      const due = t.dueDate; // stored as YYYY-MM-DD string
      return due >= todayStr && due <= tomorrowStr;
    });

    for (const task of approachingTasks) {
      // Check if we already fired this trigger today for this task
      const alreadyFired = await hasAlreadyFired(task.id, "Due date is approaching", todayStr);
      if (alreadyFired) continue;

      await evaluateWorkflows("task.due_approaching", {
        task,
        userId: task.ownerId,
        spaceId: task.spaceId,
      });
    }

    // ── 2. Task becomes overdue (dueDate < today, not completed) ──────────
    const overdueTasks = allTasks.filter((t) => {
      if (!t.dueDate) return false;
      return t.dueDate < todayStr;
    });

    for (const task of overdueTasks) {
      const alreadyFired = await hasAlreadyFired(task.id, "Task becomes overdue", todayStr);
      if (alreadyFired) continue;

      await evaluateWorkflows("task.overdue", {
        task,
        userId: task.ownerId,
        spaceId: task.spaceId,
      });
    }

    // Only log when something actually matches
    const approachingFired = approachingTasks.length > 0;
    const overdueFired = overdueTasks.length > 0;
    if (approachingFired || overdueFired) {
      console.log(`[WorkflowCron] ${approachingTasks.length} approaching, ${overdueTasks.length} overdue`);
    }
  } catch (err) {
    console.error("[WorkflowCron] Error:", err);
  }
}

/**
 * Check if a workflow has already fired for a given task+trigger combo today.
 */
async function hasAlreadyFired(taskId: string, trigger: string, todayStr: string): Promise<boolean> {
  const logs = await db
    .select()
    .from(workflowLogs)
    .where(
      and(
        eq(workflowLogs.taskId, taskId),
        eq(workflowLogs.trigger, trigger),
        gt(workflowLogs.executedAt, new Date(todayStr))
      )
    )
    .limit(1);
  return logs.length > 0;
}

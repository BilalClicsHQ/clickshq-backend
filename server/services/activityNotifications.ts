/**
 * In-app notifications for everyday activity.
 *
 * Every function here is fire-and-forget: call it without awaiting and it will
 * never break the request it was called from. A failure is logged, nothing more.
 *
 *   task_assigned   someone put you on a task
 *   task_completed  a task you own or work on was moved to a done status
 *   comment         someone commented on a task you own or work on
 *   mention         someone wrote @you in a comment
 *   space_invite    someone added you to a space
 */
import { storage } from "../storage";
import { notify } from "./notificationService";
import type { Task } from "@shared/schema";

const APP_URL = () => process.env.FRONTEND_URL || process.env.APP_URL || "http://localhost:5173";

const taskLink = (task: Pick<Task, "id" | "spaceId">) => `/spaces/${task.spaceId}/tasks/${task.id}`;

/** Unique, non-empty recipient ids with the actor removed. */
function recipients(ids: (string | null | undefined)[], actorId?: string | null): string[] {
  return [...new Set(ids.filter((id): id is string => !!id && id !== actorId))];
}

async function displayName(userId?: string | null): Promise<string> {
  if (!userId) return "Someone";
  try {
    const user = await storage.getUser(userId);
    return user?.displayName || user?.email?.split("@")[0] || "Someone";
  } catch {
    return "Someone";
  }
}

/** Trim a comment down to something that reads well inside a notification row. */
const snippet = (text: string, max = 140) => {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};

/** A status counts as "done" by its name — the same rule the AI agents use. */
export const isDoneStatus = (name = "") => /complete|done|closed|finish|resolved/i.test(name);

async function statusName(statusId: string | null | undefined, spaceId: string): Promise<string> {
  if (!statusId) return "";
  try {
    const statuses = await storage.getSpaceStatuses(spaceId);
    return statuses.find((s) => s.id === statusId)?.name ?? "";
  } catch {
    return "";
  }
}

/** Wrap a notification job so a failure can never reach the caller. */
function safely(label: string, job: () => Promise<void>): void {
  job().catch((err) => console.error(`[Notification] ${label} failed:`, err instanceof Error ? err.message : err));
}

/* ─────────────────────────── 1) Task assigned ─────────────────────────── */

export function notifyTaskAssigned(params: {
  task: Task;
  actorId: string;
  assigneeIds: string[];
  previousAssigneeIds?: string[];
}): void {
  safely("task_assigned", async () => {
    const before = new Set(params.previousAssigneeIds ?? []);
    const added = params.assigneeIds.filter((id) => !before.has(id));
    const to = recipients(added, params.actorId);
    if (!to.length) return;

    const actor = await displayName(params.actorId);
    for (const userId of to) {
      await notify({
        userId,
        type: "task_assigned",
        title: actor,
        message: `assigned you to "${params.task.name}"`,
        link: taskLink(params.task),
        metadata: { taskId: params.task.id, spaceId: params.task.spaceId, actorId: params.actorId },
      });
    }
  });
}

/* ────────────────────────── 2) Task completed ─────────────────────────── */

export function notifyTaskCompleted(params: { task: Task; actorId: string }): void {
  safely("task_completed", async () => {
    const name = await statusName(params.task.statusId, params.task.spaceId);
    if (!isDoneStatus(name)) return;

    const to = recipients([params.task.ownerId, ...(params.task.assigneeIds ?? [])], params.actorId);
    if (!to.length) return;

    const actor = await displayName(params.actorId);
    for (const userId of to) {
      await notify({
        userId,
        type: "task_completed",
        title: actor,
        message: `completed "${params.task.name}"`,
        link: taskLink(params.task),
        metadata: { taskId: params.task.id, spaceId: params.task.spaceId, actorId: params.actorId },
      });
    }
  });
}

/* ──────────────────── 3) Comment + 4) @mention ────────────────────────── */

export function notifyTaskComment(params: {
  taskId: string;
  actorId: string;
  content: string;
  mentionedUserIds?: string[];
}): void {
  safely("comment", async () => {
    const task = await storage.getTask(params.taskId);
    if (!task) return;

    const actor = await displayName(params.actorId);
    const preview = snippet(params.content);
    const mentioned = recipients(params.mentionedUserIds ?? [], params.actorId);

    // Mentioned people get the stronger "mention" notification…
    for (const userId of mentioned) {
      await notify({
        userId,
        type: "mention",
        title: actor,
        message: `mentioned you on "${task.name}": ${preview}`,
        link: taskLink(task),
        metadata: { taskId: task.id, spaceId: task.spaceId, actorId: params.actorId, source: "task_comment" },
      });
    }

    // …everyone else involved in the task gets the plain comment one.
    const mentionedSet = new Set(mentioned);
    const watchers = recipients([task.ownerId, ...(task.assigneeIds ?? [])], params.actorId)
      .filter((id) => !mentionedSet.has(id));

    for (const userId of watchers) {
      await notify({
        userId,
        type: "comment",
        title: actor,
        message: `commented on "${task.name}": ${preview}`,
        link: taskLink(task),
        metadata: { taskId: task.id, spaceId: task.spaceId, actorId: params.actorId },
      });
    }
  });
}

/* ─────────────────────────── 5) Space invite ──────────────────────────── */

export function notifySpaceInvite(params: {
  userId: string;
  spaceId: string;
  spaceName: string;
  actorId: string;
}): void {
  safely("space_invite", async () => {
    const to = recipients([params.userId], params.actorId);
    if (!to.length) return;

    const actor = await displayName(params.actorId);
    await notify({
      userId: to[0],
      type: "space_invite",
      title: actor,
      message: `added you to the space "${params.spaceName}"`,
      link: `/spaces/${params.spaceId}`,
      metadata: { spaceId: params.spaceId, actorId: params.actorId },
    });
  });
}

export { APP_URL };

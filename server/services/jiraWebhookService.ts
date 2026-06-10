/**
 * Jira Webhook Event Processor.
 *
 * Receives parsed events from the webhook route and:
 *   1. Looks up which clicsHQ space(s) have this Jira project connected.
 *   2. If issue text mentions a TASK-N reference, auto-links to that task.
 *   3. Otherwise, updates existing links by issueKey.
 *   4. Writes activity timeline entries.
 *   5. Applies auto-status transitions when configured.
 *   6. Emits notifications to task stakeholders.
 *
 * Jira webhook events we handle:
 *   - jira:issue_created
 *   - jira:issue_updated   (status, assignee, summary changes)
 *   - jira:issue_deleted
 *   - comment_created
 */
import { storage } from "../storage";
import { parseTaskReferences, adfToText } from "./jiraService";
import { notifyMany } from "./notificationService";

interface ProjectCtx {
  id: string;
  spaceId: string;
  cloudId: string;
  projectKey: string;
  autoStatusOnInProgress?: string | null;
  autoStatusOnDone?: string | null;
  autoStatusOnBlocked?: string | null;
}

/** Find all space-project connections for a given Jira project. */
async function findProjectsByKey(cloudId: string, projectKey: string): Promise<ProjectCtx[]> {
  const rows = await storage.getJiraProjectsByKey(cloudId, projectKey);
  return rows.map((r) => ({
    id: r.id,
    spaceId: r.spaceId,
    cloudId: r.cloudId,
    projectKey: r.projectKey,
    autoStatusOnInProgress: r.autoStatusOnInProgress,
    autoStatusOnDone: r.autoStatusOnDone,
    autoStatusOnBlocked: r.autoStatusOnBlocked,
  }));
}

async function findTasksByRefs(spaceId: string, refs: number[]) {
  const tasks = [];
  for (const ref of refs) {
    const t = await storage.getTaskByShortId(spaceId, ref);
    if (t) tasks.push(t);
  }
  return tasks;
}

async function notifyTaskStakeholders(
  task: { id: string; spaceId: string; ownerId: string; assigneeIds: string[]; name: string },
  params: {
    type: string;
    title: string;
    message: string;
    extraMetadata?: Record<string, any>;
  },
) {
  const recipients = new Set<string>();
  if (task.ownerId) recipients.add(task.ownerId);
  for (const a of task.assigneeIds || []) recipients.add(a);
  if (recipients.size === 0) return;

  await notifyMany([...recipients], {
    type: params.type,
    title: params.title,
    message: params.message,
    link: `/spaces/${task.spaceId}/tasks/${task.id}`,
    metadata: {
      taskId: task.id,
      spaceId: task.spaceId,
      ...params.extraMetadata,
    },
  });
}

// ── Issue Created ───────────────────────────────────────────────────────────
async function handleIssueCreated(payload: any, cloudId: string) {
  const issue = payload.issue;
  if (!issue) return;
  const projectKey = issue.fields?.project?.key;
  if (!projectKey) return;

  const projects = await findProjectsByKey(cloudId, projectKey);
  if (projects.length === 0) return;

  const summary = issue.fields?.summary ?? "";
  const description = adfToText(issue.fields?.description);
  const refs = parseTaskReferences(summary + " " + description);

  for (const ctx of projects) {
    const tasks = await findTasksByRefs(ctx.spaceId, refs);
    for (const task of tasks) {
      await upsertJiraLink(task.id, cloudId, issue, true);
      await storage.createTaskActivity({
        taskId: task.id,
        type: "jira_issue_created",
        actorExternalLogin: issue.fields?.creator?.displayName,
        actorExternalAvatar: issue.fields?.creator?.avatarUrls?.["24x24"],
        payload: {
          issueKey: issue.key,
          issueUrl: issueUrlOf(issue),
          summary,
          projectKey,
        },
      });
      await notifyTaskStakeholders(task, {
        type: "jira_issue_created",
        title: `${issue.fields?.creator?.displayName ?? "Someone"} created ${issue.key}`,
        message: summary,
        extraMetadata: { issueKey: issue.key, issueUrl: issueUrlOf(issue) },
      });
    }
  }
}

// ── Issue Updated (status, assignee, summary, etc.) ─────────────────────────
async function handleIssueUpdated(payload: any, cloudId: string) {
  const issue = payload.issue;
  if (!issue) return;
  const projectKey = issue.fields?.project?.key;
  if (!projectKey) return;

  // Find tasks already linked to this Jira issue
  const linkedTasks = await storage.findLinksByJiraIssue(cloudId, issue.key);
  const projects = await findProjectsByKey(cloudId, projectKey);

  // Also check for new task refs in updated text
  const summary = issue.fields?.summary ?? "";
  const description = adfToText(issue.fields?.description);
  const refs = parseTaskReferences(summary + " " + description);

  // Collect all tasks to act on (linked + newly referenced)
  const tasksToProcess = new Map<string, any>();
  for (const link of linkedTasks) {
    const task = await storage.getTask(link.taskId);
    if (task) tasksToProcess.set(task.id, task);
  }
  for (const ctx of projects) {
    const matched = await findTasksByRefs(ctx.spaceId, refs);
    for (const t of matched) tasksToProcess.set(t.id, t);
  }

  // Identify what changed from the changelog
  const changelog: any[] = payload.changelog?.items ?? [];
  const statusChange = changelog.find((c) => c.field === "status");
  const assigneeChange = changelog.find((c) => c.field === "assignee");

  for (const task of tasksToProcess.values()) {
    // Upsert link with latest data
    await upsertJiraLink(task.id, cloudId, issue, true);

    // Activity entry
    await storage.createTaskActivity({
      taskId: task.id,
      type: "jira_issue_updated",
      actorExternalLogin: payload.user?.displayName,
      actorExternalAvatar: payload.user?.avatarUrls?.["24x24"],
      payload: {
        issueKey: issue.key,
        issueUrl: issueUrlOf(issue),
        summary,
        statusChange: statusChange ? { from: statusChange.fromString, to: statusChange.toString } : null,
        assigneeChange: assigneeChange ? { from: assigneeChange.fromString, to: assigneeChange.toString } : null,
      },
    });

    // Notification
    if (statusChange || assigneeChange) {
      const verb = statusChange
        ? `moved ${issue.key} to ${statusChange.toString}`
        : `reassigned ${issue.key} to ${assigneeChange?.toString}`;
      await notifyTaskStakeholders(task, {
        type: "jira_issue_updated",
        title: `${payload.user?.displayName ?? "Someone"} ${verb}`,
        message: summary,
        extraMetadata: { issueKey: issue.key, issueUrl: issueUrlOf(issue) },
      });
    }

    // Auto-status mapping (find the connection that owns this task's space)
    if (statusChange) {
      const projectForTask = projects.find((p) => p.spaceId === task.spaceId);
      if (projectForTask) {
        const newJiraStatus = String(statusChange.toString || "").toLowerCase();
        let nextStatusId: string | null | undefined;
        if (newJiraStatus.includes("progress") && projectForTask.autoStatusOnInProgress) {
          nextStatusId = projectForTask.autoStatusOnInProgress;
        } else if (newJiraStatus.includes("done") && projectForTask.autoStatusOnDone) {
          nextStatusId = projectForTask.autoStatusOnDone;
        } else if (newJiraStatus.includes("block") && projectForTask.autoStatusOnBlocked) {
          nextStatusId = projectForTask.autoStatusOnBlocked;
        }
        if (nextStatusId && task.statusId !== nextStatusId) {
          await storage.updateTask(task.id, { statusId: nextStatusId } as any);
          await storage.createTaskActivity({
            taskId: task.id,
            type: "status_changed",
            actorExternalLogin: payload.user?.displayName,
            payload: {
              from: task.statusId,
              to: nextStatusId,
              reason: `Auto: Jira ${issue.key} moved to ${statusChange.toString}`,
            },
          });
        }
      }
    }
  }
}

// ── Issue Deleted ───────────────────────────────────────────────────────────
async function handleIssueDeleted(payload: any, cloudId: string) {
  const issue = payload.issue;
  if (!issue) return;

  const linkedTasks = await storage.findLinksByJiraIssue(cloudId, issue.key);
  for (const link of linkedTasks) {
    await storage.createTaskActivity({
      taskId: link.taskId,
      type: "jira_issue_deleted",
      actorExternalLogin: payload.user?.displayName,
      payload: {
        issueKey: issue.key,
        summary: link.summary,
      },
    });
    // We keep the link record but mark its state as deleted
    await storage.updateTaskJiraLink(link.id, { status: "deleted" });
  }
}

// ── Comment Created ─────────────────────────────────────────────────────────
async function handleCommentCreated(payload: any, cloudId: string) {
  const issue = payload.issue;
  const comment = payload.comment;
  if (!issue || !comment) return;

  const linkedTasks = await storage.findLinksByJiraIssue(cloudId, issue.key);
  const commentText = adfToText(comment.body);

  for (const link of linkedTasks) {
    await storage.createTaskActivity({
      taskId: link.taskId,
      type: "jira_comment_created",
      actorExternalLogin: comment.author?.displayName,
      actorExternalAvatar: comment.author?.avatarUrls?.["24x24"],
      payload: {
        issueKey: issue.key,
        issueUrl: issueUrlOf(issue),
        commentText,
        commentId: comment.id,
      },
    });
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function issueUrlOf(issue: any): string {
  // Jira webhook payloads include `self` (API URL) — convert to user-facing URL
  const self = issue.self ?? "";
  const match = self.match(/^(https?:\/\/[^/]+)/);
  const base = match ? match[1] : "";
  return base ? `${base}/browse/${issue.key}` : `https://atlassian.net/browse/${issue.key}`;
}

async function upsertJiraLink(taskId: string, cloudId: string, issue: any, autoLinked: boolean) {
  const existing = await storage.findTaskJiraLink(taskId, cloudId, issue.key);
  const data: any = {
    taskId,
    cloudId,
    issueKey: issue.key,
    issueId: String(issue.id),
    issueUrl: issueUrlOf(issue),
    summary: issue.fields?.summary,
    status: issue.fields?.status?.name,
    issueType: issue.fields?.issuetype?.name,
    priority: issue.fields?.priority?.name,
    assigneeName: issue.fields?.assignee?.displayName,
    assigneeAvatar: issue.fields?.assignee?.avatarUrls?.["24x24"],
    autoLinked,
    metadata: {
      labels: issue.fields?.labels ?? [],
      components: (issue.fields?.components ?? []).map((c: any) => c.name),
    },
  };
  if (existing) {
    await storage.updateTaskJiraLink(existing.id, data);
  } else {
    await storage.createTaskJiraLink(data);
  }
}

// ── Master Dispatcher ───────────────────────────────────────────────────────
export async function processJiraWebhookEvent(event: string, payload: any, cloudId: string) {
  switch (event) {
    case "jira:issue_created":
      return handleIssueCreated(payload, cloudId);
    case "jira:issue_updated":
      return handleIssueUpdated(payload, cloudId);
    case "jira:issue_deleted":
      return handleIssueDeleted(payload, cloudId);
    case "comment_created":
      return handleCommentCreated(payload, cloudId);
    default:
      return;
  }
}

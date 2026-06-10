/**
 * GitHub Webhook Event Processor.
 *
 * Receives parsed events from the webhook route and:
 *   1. Parses task references from text (commit messages, PR titles/bodies, branches).
 *   2. Creates/updates `task_github_links` rows for affected tasks.
 *   3. Writes `task_activities` rows so the timeline reflects external events.
 *   4. Applies auto-status transitions when configured per repo.
 *   5. Emits in-app notifications to relevant users (task assignees + owner).
 *
 * Each handler is best-effort: if any single task linkage fails, others still run.
 */
import { storage } from "../storage";
import {
  parseTaskReferences,
  parseTaskReferencesMulti,
} from "./githubService";
import { notifyMany } from "./notificationService";

// ── Shared helpers ──────────────────────────────────────────────────────────

interface RepoCtx {
  spaceGithubRepoId: string;
  spaceId: string;
  repoFullName: string;
  autoStatusOnPrOpen?: string | null;
  autoStatusOnPrMerged?: string | null;
  autoStatusOnPrClosed?: string | null;
}

/**
 * Resolve the configured repo for a given full name. Falls back to any
 * connected space mapping (first match) if multiple spaces have the repo.
 */
async function findReposByFullName(repoFullName: string): Promise<RepoCtx[]> {
  // We don't have a direct lookup helper yet — webhooks table has it.
  const webhooks = await storage.getGithubWebhooksByRepo(repoFullName);
  const seen = new Set<string>();
  const ctx: RepoCtx[] = [];
  for (const w of webhooks) {
    if (seen.has(w.spaceGithubRepoId)) continue;
    seen.add(w.spaceGithubRepoId);
    const repo = await storage.getSpaceGithubRepoById(w.spaceGithubRepoId);
    if (!repo) continue;
    ctx.push({
      spaceGithubRepoId: repo.id,
      spaceId: repo.spaceId,
      repoFullName: repo.repoFullName,
      autoStatusOnPrOpen: repo.autoStatusOnPrOpen,
      autoStatusOnPrMerged: repo.autoStatusOnPrMerged,
      autoStatusOnPrClosed: repo.autoStatusOnPrClosed,
    });
  }
  return ctx;
}

/**
 * Find clicsHQ tasks (by shortId) inside a given space.
 * Returns the actual task rows (UUID + assignees + owner).
 */
async function findTasksByRefs(spaceId: string, refs: number[]) {
  const tasks = [];
  for (const ref of refs) {
    const t = await storage.getTaskByShortId(spaceId, ref);
    if (t) tasks.push(t);
  }
  return tasks;
}

/**
 * Notify task stakeholders (owner + assignees, deduped, excluding actor).
 */
async function notifyTaskStakeholders(
  task: { id: string; spaceId: string; ownerId: string; assigneeIds: string[]; name: string },
  params: {
    type: string;
    title: string;
    message: string;
    actorExternalLogin?: string;
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

// ── Pull Request Events ─────────────────────────────────────────────────────

export async function handlePullRequestEvent(payload: any) {
  const action = payload.action; // opened | closed | reopened | edited | synchronize
  const pr = payload.pull_request;
  if (!pr) return;

  const repoFullName: string = payload.repository?.full_name;
  if (!repoFullName) return;

  const repoCtxs = await findReposByFullName(repoFullName);
  if (repoCtxs.length === 0) return; // No connected space for this repo

  // Parse task refs from PR title + body + head branch
  const refs = parseTaskReferencesMulti(pr.title, pr.body, pr.head?.ref);

  for (const ctx of repoCtxs) {
    const tasks = await findTasksByRefs(ctx.spaceId, refs);
    for (const task of tasks) {
      // Determine PR state
      const merged = pr.merged === true;
      const state = merged ? "merged" : pr.state; // 'open' | 'closed' | 'merged'

      // Upsert link
      const existing = await storage.findTaskGithubLink(
        task.id,
        "pr",
        repoFullName,
        String(pr.number),
      );
      const linkData = {
        taskId: task.id,
        type: "pr",
        repoFullName,
        externalId: String(pr.number),
        externalUrl: pr.html_url,
        title: pr.title,
        state,
        authorLogin: pr.user?.login,
        authorAvatar: pr.user?.avatar_url,
        autoLinked: true,
        metadata: {
          additions: pr.additions,
          deletions: pr.deletions,
          changedFiles: pr.changed_files,
          head: pr.head?.ref,
          base: pr.base?.ref,
        },
      };
      if (existing) {
        await storage.updateTaskGithubLink(existing.id, linkData);
      } else {
        await storage.createTaskGithubLink(linkData);
      }

      // Activity timeline entry
      let activityType: string | null = null;
      if (action === "opened") activityType = "github_pr_opened";
      else if (action === "closed") {
        activityType = merged ? "github_pr_merged" : "github_pr_closed";
      } else if (action === "reopened") activityType = "github_pr_reopened";

      if (activityType) {
        await storage.createTaskActivity({
          taskId: task.id,
          type: activityType,
          actorExternalLogin: pr.user?.login,
          actorExternalAvatar: pr.user?.avatar_url,
          payload: {
            prNumber: pr.number,
            prTitle: pr.title,
            prUrl: pr.html_url,
            repoFullName,
            merged,
            head: pr.head?.ref,
            base: pr.base?.ref,
          },
        });

        // In-app notification to task stakeholders
        const verb =
          activityType === "github_pr_opened"
            ? "opened PR"
            : activityType === "github_pr_merged"
              ? "merged PR"
              : activityType === "github_pr_closed"
                ? "closed PR"
                : "reopened PR";
        await notifyTaskStakeholders(task, {
          type: activityType,
          title: `${pr.user?.login} ${verb} #${pr.number}`,
          message: pr.title,
          actorExternalLogin: pr.user?.login,
          extraMetadata: {
            prNumber: pr.number,
            prUrl: pr.html_url,
            repoFullName,
          },
        });
      }

      // Auto-status transitions
      let nextStatusId: string | null | undefined = undefined;
      if (action === "opened" && ctx.autoStatusOnPrOpen) {
        nextStatusId = ctx.autoStatusOnPrOpen;
      } else if (action === "closed" && merged && ctx.autoStatusOnPrMerged) {
        nextStatusId = ctx.autoStatusOnPrMerged;
      } else if (action === "closed" && !merged && ctx.autoStatusOnPrClosed) {
        nextStatusId = ctx.autoStatusOnPrClosed;
      }
      if (nextStatusId && task.statusId !== nextStatusId) {
        await storage.updateTask(task.id, { statusId: nextStatusId } as any);
        await storage.createTaskActivity({
          taskId: task.id,
          type: "status_changed",
          actorExternalLogin: pr.user?.login,
          payload: {
            from: task.statusId,
            to: nextStatusId,
            reason: `Auto: PR #${pr.number} ${merged ? "merged" : action}`,
          },
        });
      }
    }
  }
}

// ── Pull Request Review Events ──────────────────────────────────────────────

export async function handlePullRequestReviewEvent(payload: any) {
  const action = payload.action; // submitted | edited | dismissed
  if (action !== "submitted") return;

  const review = payload.review;
  const pr = payload.pull_request;
  const repoFullName: string = payload.repository?.full_name;
  if (!review || !pr || !repoFullName) return;

  const refs = parseTaskReferencesMulti(pr.title, pr.body, pr.head?.ref);
  const repoCtxs = await findReposByFullName(repoFullName);

  for (const ctx of repoCtxs) {
    const tasks = await findTasksByRefs(ctx.spaceId, refs);
    for (const task of tasks) {
      await storage.createTaskActivity({
        taskId: task.id,
        type: "github_review",
        actorExternalLogin: review.user?.login,
        actorExternalAvatar: review.user?.avatar_url,
        payload: {
          prNumber: pr.number,
          prTitle: pr.title,
          prUrl: pr.html_url,
          repoFullName,
          state: review.state, // approved | changes_requested | commented
          body: review.body,
          submittedAt: review.submitted_at,
        },
      });

      const stateText =
        review.state === "approved"
          ? "approved"
          : review.state === "changes_requested"
            ? "requested changes on"
            : "reviewed";
      await notifyTaskStakeholders(task, {
        type: "github_review",
        title: `${review.user?.login} ${stateText} PR #${pr.number}`,
        message: pr.title,
        actorExternalLogin: review.user?.login,
        extraMetadata: {
          prNumber: pr.number,
          prUrl: pr.html_url,
          reviewState: review.state,
        },
      });
    }
  }
}

// ── Push Events (commits) ───────────────────────────────────────────────────

export async function handlePushEvent(payload: any) {
  const commits: any[] = payload.commits ?? [];
  if (commits.length === 0) return;

  const repoFullName: string = payload.repository?.full_name;
  if (!repoFullName) return;

  const repoCtxs = await findReposByFullName(repoFullName);
  if (repoCtxs.length === 0) return;

  const branchRef: string = payload.ref ?? ""; // e.g. "refs/heads/main"
  const branchName = branchRef.replace(/^refs\/heads\//, "");

  for (const commit of commits) {
    // Parse task refs from commit message + branch name
    const refs = parseTaskReferencesMulti(commit.message, branchName);
    if (refs.length === 0) continue;

    for (const ctx of repoCtxs) {
      const tasks = await findTasksByRefs(ctx.spaceId, refs);
      for (const task of tasks) {
        // Upsert link (commits are immutable but idempotency matters)
        const existing = await storage.findTaskGithubLink(
          task.id,
          "commit",
          repoFullName,
          commit.id,
        );
        const linkData = {
          taskId: task.id,
          type: "commit",
          repoFullName,
          externalId: commit.id,
          externalUrl: commit.url,
          title: commit.message?.split("\n")[0]?.slice(0, 200),
          authorLogin: commit.author?.username || commit.author?.name,
          authorAvatar: undefined,
          autoLinked: true,
          metadata: {
            sha: commit.id,
            branch: branchName,
            timestamp: commit.timestamp,
            authorEmail: commit.author?.email,
          },
        };
        if (!existing) {
          await storage.createTaskGithubLink(linkData);
        }

        // Activity timeline
        await storage.createTaskActivity({
          taskId: task.id,
          type: "github_commit",
          actorExternalLogin: commit.author?.username || commit.author?.name,
          payload: {
            sha: commit.id,
            shortSha: commit.id.slice(0, 7),
            message: commit.message,
            url: commit.url,
            branch: branchName,
            repoFullName,
            timestamp: commit.timestamp,
          },
        });
      }
    }
  }
}

// ── Issue Events ────────────────────────────────────────────────────────────

export async function handleIssuesEvent(payload: any) {
  const action = payload.action; // opened | closed | reopened | edited
  const issue = payload.issue;
  if (!issue) return;

  // Skip pull-request-as-issue payloads (GitHub also fires `issues` for PRs)
  if (issue.pull_request) return;

  const repoFullName: string = payload.repository?.full_name;
  if (!repoFullName) return;

  const repoCtxs = await findReposByFullName(repoFullName);
  if (repoCtxs.length === 0) return;

  const refs = parseTaskReferencesMulti(issue.title, issue.body);

  for (const ctx of repoCtxs) {
    const tasks = await findTasksByRefs(ctx.spaceId, refs);
    for (const task of tasks) {
      const existing = await storage.findTaskGithubLink(
        task.id,
        "issue",
        repoFullName,
        String(issue.number),
      );
      const linkData = {
        taskId: task.id,
        type: "issue",
        repoFullName,
        externalId: String(issue.number),
        externalUrl: issue.html_url,
        title: issue.title,
        state: issue.state,
        authorLogin: issue.user?.login,
        authorAvatar: issue.user?.avatar_url,
        autoLinked: true,
        metadata: {
          labels: (issue.labels ?? []).map((l: any) => l.name),
          assignees: (issue.assignees ?? []).map((a: any) => a.login),
        },
      };
      if (existing) {
        await storage.updateTaskGithubLink(existing.id, linkData);
      } else {
        await storage.createTaskGithubLink(linkData);
      }

      let activityType: string | null = null;
      if (action === "opened") activityType = "github_issue_opened";
      else if (action === "closed") activityType = "github_issue_closed";
      else if (action === "reopened") activityType = "github_issue_reopened";

      if (activityType) {
        await storage.createTaskActivity({
          taskId: task.id,
          type: activityType,
          actorExternalLogin: issue.user?.login,
          actorExternalAvatar: issue.user?.avatar_url,
          payload: {
            issueNumber: issue.number,
            issueTitle: issue.title,
            issueUrl: issue.html_url,
            repoFullName,
          },
        });

        const verb =
          activityType === "github_issue_opened"
            ? "opened issue"
            : activityType === "github_issue_closed"
              ? "closed issue"
              : "reopened issue";
        await notifyTaskStakeholders(task, {
          type: activityType,
          title: `${issue.user?.login} ${verb} #${issue.number}`,
          message: issue.title,
          actorExternalLogin: issue.user?.login,
          extraMetadata: {
            issueNumber: issue.number,
            issueUrl: issue.html_url,
            repoFullName,
          },
        });
      }
    }
  }
}

// ── Issue / PR Comment Events ───────────────────────────────────────────────

export async function handleIssueCommentEvent(payload: any) {
  if (payload.action !== "created") return;

  const comment = payload.comment;
  const issue = payload.issue;
  if (!comment || !issue) return;

  const repoFullName: string = payload.repository?.full_name;
  if (!repoFullName) return;

  const repoCtxs = await findReposByFullName(repoFullName);
  if (repoCtxs.length === 0) return;

  // Refs from comment body + issue/PR title for context
  const refs = parseTaskReferencesMulti(comment.body, issue.title, issue.body);

  for (const ctx of repoCtxs) {
    const tasks = await findTasksByRefs(ctx.spaceId, refs);
    for (const task of tasks) {
      const isPR = !!issue.pull_request;
      await storage.createTaskActivity({
        taskId: task.id,
        type: isPR ? "github_pr_comment" : "github_issue_comment",
        actorExternalLogin: comment.user?.login,
        actorExternalAvatar: comment.user?.avatar_url,
        payload: {
          commentId: comment.id,
          commentUrl: comment.html_url,
          commentBody: comment.body,
          issueNumber: issue.number,
          issueTitle: issue.title,
          repoFullName,
        },
      });
    }
  }
}

// ── Master Dispatcher ───────────────────────────────────────────────────────

export async function processWebhookEvent(event: string, payload: any) {
  switch (event) {
    case "pull_request":
      return handlePullRequestEvent(payload);
    case "pull_request_review":
      return handlePullRequestReviewEvent(payload);
    case "push":
      return handlePushEvent(payload);
    case "issues":
      return handleIssuesEvent(payload);
    case "issue_comment":
      return handleIssueCommentEvent(payload);
    case "ping":
      // GitHub sends a ping when a webhook is installed
      return;
    default:
      return; // Silently ignore unsupported events
  }
}

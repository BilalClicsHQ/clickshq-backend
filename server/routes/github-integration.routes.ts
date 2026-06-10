/**
 * GitHub Integration routes (space-level + task-level).
 *
 * Mounted at /api/integrations/github.
 *
 *  Space-level:
 *    POST   /spaces/:spaceId/repos               – Connect a repo to a space (installs webhook)
 *    GET    /spaces/:spaceId/repos               – List connected repos for a space
 *    DELETE /spaces/:spaceId/repos/:id           – Disconnect a repo (removes webhook)
 *    PATCH  /spaces/:spaceId/repos/:id           – Update auto-status mapping
 *
 *  Task-level:
 *    GET    /tasks/:taskId/links                 – List GitHub links on a task
 *    POST   /tasks/:taskId/links                 – Manually link an external GitHub entity
 *    DELETE /tasks/:taskId/links/:linkId         – Unlink
 *    POST   /tasks/:taskId/issue                 – Push task → new GitHub issue
 *    GET    /tasks/:taskId/activities            – Task activity timeline (incl. GitHub)
 */
import { Router, Request, Response } from "express";
import { requireAuth } from "../auth";
import { storage } from "../storage";
import { getToken } from "../services/tokenService";
import {
  getRepo,
  getRepoPermissions,
  installWebhook,
  uninstallWebhook,
  generateWebhookSecret,
  DEFAULT_WEBHOOK_EVENTS,
  createIssue,
} from "../services/githubService";

const router = Router();

async function getUserToken(userId: string) {
  const token = await getToken(userId, "github");
  return token?.accessToken ?? null;
}

function getPublicWebhookUrl(): string {
  const base =
    process.env.WEBHOOK_PUBLIC_URL ||
    process.env.APP_URL ||
    "http://localhost:4000";
  return `${base.replace(/\/$/, "")}/api/webhooks/github`;
}

// ── Connect a repo to a space ───────────────────────────────────────────────

router.post(
  "/spaces/:spaceId/repos",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const user = req.user as any;
      const { spaceId } = req.params;
      const { repoFullName } = req.body;
      if (!repoFullName) {
        return res
          .status(400)
          .json({ success: false, error: { code: "MISSING_REPO", message: "repoFullName is required" } });
      }

      const token = await getUserToken(user.id);
      if (!token) {
        return res
          .status(403)
          .json({ success: false, error: { code: "NOT_CONNECTED", message: "Connect GitHub first" } });
      }

      // Already connected?
      const existing = await storage.getSpaceGithubRepoByFullName(
        spaceId,
        repoFullName,
      );
      if (existing) {
        return res.status(409).json({
          success: false,
          error: { code: "ALREADY_CONNECTED", message: "Repo already connected to this space" },
        });
      }

      // Verify user has admin rights on the repo (webhook install requires it)
      const [owner, repoName] = repoFullName.split("/");
      if (!owner || !repoName) {
        return res
          .status(400)
          .json({ success: false, error: { code: "INVALID_REPO", message: "Expected owner/repo format" } });
      }

      const perms = await getRepoPermissions(token, owner, repoName);
      if (!perms.admin) {
        return res.status(403).json({
          success: false,
          error: {
            code: "INSUFFICIENT_PERMISSIONS",
            message: "You need admin access on this repository to install webhooks.",
          },
        });
      }

      const repoInfo = await getRepo(token, owner, repoName);
      const repoId = (repoInfo as any).id as number;
      const repoUrl = (repoInfo as any).html_url as string;
      const defaultBranch = (repoInfo as any).default_branch as string | undefined;

      // Install webhook
      const secret = generateWebhookSecret();
      const callbackUrl = getPublicWebhookUrl();
      let webhookId: number;
      try {
        const hook = await installWebhook(
          token,
          owner,
          repoName,
          callbackUrl,
          secret,
          DEFAULT_WEBHOOK_EVENTS,
        );
        webhookId = hook.id;
      } catch (err: any) {
        return res.status(502).json({
          success: false,
          error: {
            code: "WEBHOOK_INSTALL_FAILED",
            message: err.message || "Could not install webhook on GitHub",
          },
        });
      }

      // Persist the connection
      const spaceRepo = await storage.createSpaceGithubRepo({
        spaceId,
        repoFullName,
        repoId,
        repoUrl,
        defaultBranch,
        connectedBy: user.id,
      });

      await storage.createGithubWebhook({
        spaceGithubRepoId: spaceRepo.id,
        repoFullName,
        webhookId,
        secret,
        events: DEFAULT_WEBHOOK_EVENTS,
      });

      return res.json({ success: true, data: spaceRepo });
    } catch (err: any) {
      console.error("[GitHub] Connect repo error:", err);
      return res
        .status(500)
        .json({ success: false, error: { code: "INTERNAL", message: err.message } });
    }
  },
);

// ── List connected repos for a space ────────────────────────────────────────

router.get(
  "/spaces/:spaceId/repos",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const { spaceId } = req.params;
      const repos = await storage.getSpaceGithubRepos(spaceId);
      return res.json({ success: true, data: repos });
    } catch (err: any) {
      return res
        .status(500)
        .json({ success: false, error: { code: "INTERNAL", message: err.message } });
    }
  },
);

// ── Update auto-status mapping ──────────────────────────────────────────────

router.patch(
  "/spaces/:spaceId/repos/:id",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const {
        autoStatusOnPrOpen,
        autoStatusOnPrMerged,
        autoStatusOnPrClosed,
      } = req.body;
      const updated = await storage.updateSpaceGithubRepo(id, {
        autoStatusOnPrOpen,
        autoStatusOnPrMerged,
        autoStatusOnPrClosed,
      });
      if (!updated) return res.status(404).json({ success: false, error: { code: "NOT_FOUND" } });
      return res.json({ success: true, data: updated });
    } catch (err: any) {
      return res
        .status(500)
        .json({ success: false, error: { code: "INTERNAL", message: err.message } });
    }
  },
);

// ── Disconnect a repo ───────────────────────────────────────────────────────

router.delete(
  "/spaces/:spaceId/repos/:id",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const user = req.user as any;
      const { id } = req.params;
      const repo = await storage.getSpaceGithubRepoById(id);
      if (!repo) return res.status(404).json({ success: false, error: { code: "NOT_FOUND" } });

      // Try to uninstall webhook from GitHub (best-effort)
      const token = await getUserToken(user.id);
      if (token) {
        const [owner, repoName] = repo.repoFullName.split("/");
        const hooks = await storage.getGithubWebhooksByRepo(repo.repoFullName);
        for (const h of hooks) {
          if (h.spaceGithubRepoId !== id) continue;
          try {
            await uninstallWebhook(token, owner, repoName, h.webhookId);
          } catch (err) {
            console.warn(
              "[GitHub] Could not uninstall webhook (continuing):",
              (err as any).message,
            );
          }
        }
      }

      await storage.deleteGithubWebhooksByRepo(id);
      await storage.deleteSpaceGithubRepo(id);

      return res.json({ success: true });
    } catch (err: any) {
      return res
        .status(500)
        .json({ success: false, error: { code: "INTERNAL", message: err.message } });
    }
  },
);

// ── List GitHub links on a task ─────────────────────────────────────────────

router.get(
  "/tasks/:taskId/links",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const { taskId } = req.params;
      const links = await storage.getTaskGithubLinks(taskId);
      return res.json({ success: true, data: links });
    } catch (err: any) {
      return res
        .status(500)
        .json({ success: false, error: { code: "INTERNAL", message: err.message } });
    }
  },
);

// ── Manually link a GitHub entity to a task ─────────────────────────────────

router.post(
  "/tasks/:taskId/links",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const user = req.user as any;
      const { taskId } = req.params;
      const {
        type, // 'pr' | 'issue' | 'commit' | 'branch'
        repoFullName,
        externalId,
        externalUrl,
        title,
        state,
        authorLogin,
        authorAvatar,
      } = req.body;

      if (!type || !repoFullName || !externalId || !externalUrl) {
        return res.status(400).json({
          success: false,
          error: {
            code: "MISSING_FIELDS",
            message: "type, repoFullName, externalId, externalUrl are required",
          },
        });
      }
      if (!["pr", "issue", "commit", "branch"].includes(type)) {
        return res.status(400).json({
          success: false,
          error: { code: "INVALID_TYPE", message: "type must be pr|issue|commit|branch" },
        });
      }

      // Dedupe
      const existing = await storage.findTaskGithubLink(
        taskId,
        type,
        repoFullName,
        externalId,
      );
      if (existing) {
        return res.json({ success: true, data: existing, deduped: true });
      }

      const created = await storage.createTaskGithubLink({
        taskId,
        type,
        repoFullName,
        externalId: String(externalId),
        externalUrl,
        title,
        state,
        authorLogin,
        authorAvatar,
        linkedBy: user.id,
        autoLinked: false,
      });

      await storage.createTaskActivity({
        taskId,
        type: `github_${type}_linked_manual`,
        actorUserId: user.id,
        payload: {
          repoFullName,
          externalId,
          externalUrl,
          title,
        },
      });

      return res.json({ success: true, data: created });
    } catch (err: any) {
      return res
        .status(500)
        .json({ success: false, error: { code: "INTERNAL", message: err.message } });
    }
  },
);

// ── Unlink ──────────────────────────────────────────────────────────────────

router.delete(
  "/tasks/:taskId/links/:linkId",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const { linkId } = req.params;
      const ok = await storage.deleteTaskGithubLink(linkId);
      return res.json({ success: ok });
    } catch (err: any) {
      return res
        .status(500)
        .json({ success: false, error: { code: "INTERNAL", message: err.message } });
    }
  },
);

// ── Push task → GitHub issue ────────────────────────────────────────────────

router.post(
  "/tasks/:taskId/issue",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const user = req.user as any;
      const { taskId } = req.params;
      const { repoFullName, title, body, labels, assignees } = req.body;

      if (!repoFullName) {
        return res
          .status(400)
          .json({ success: false, error: { code: "MISSING_REPO" } });
      }

      const token = await getUserToken(user.id);
      if (!token) {
        return res
          .status(403)
          .json({ success: false, error: { code: "NOT_CONNECTED" } });
      }

      const task = await storage.getTask(taskId);
      if (!task) {
        return res
          .status(404)
          .json({ success: false, error: { code: "TASK_NOT_FOUND" } });
      }

      const [owner, repoName] = repoFullName.split("/");
      const issueTitle = title || task.name;
      const taskRef = task.shortId ? `\n\n— clicsHQ TASK-${task.shortId}` : "";
      const issueBody = (body || task.description || "") + taskRef;

      const issue: any = await createIssue(token, owner, repoName, {
        title: issueTitle,
        body: issueBody,
        labels,
        assignees,
      });

      const link = await storage.createTaskGithubLink({
        taskId,
        type: "issue",
        repoFullName,
        externalId: String(issue.number),
        externalUrl: issue.html_url,
        title: issue.title,
        state: issue.state,
        authorLogin: issue.user?.login,
        authorAvatar: issue.user?.avatar_url,
        linkedBy: user.id,
        autoLinked: false,
      });

      await storage.createTaskActivity({
        taskId,
        type: "github_issue_created",
        actorUserId: user.id,
        payload: {
          issueNumber: issue.number,
          issueUrl: issue.html_url,
          issueTitle: issue.title,
          repoFullName,
        },
      });

      return res.json({ success: true, data: { issue, link } });
    } catch (err: any) {
      console.error("[GitHub] Push issue error:", err);
      return res
        .status(500)
        .json({ success: false, error: { code: "INTERNAL", message: err.message } });
    }
  },
);

// ── Task activity timeline ──────────────────────────────────────────────────

router.get(
  "/tasks/:taskId/activities",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const { taskId } = req.params;
      const limit = parseInt(String(req.query.limit ?? "100"), 10);
      const activities = await storage.getTaskActivities(taskId, limit);
      return res.json({ success: true, data: activities });
    } catch (err: any) {
      return res
        .status(500)
        .json({ success: false, error: { code: "INTERNAL", message: err.message } });
    }
  },
);

// ── Post a comment on a task ────────────────────────────────────────────────
// Body: { text: string, mentionedTaskIds?: string[], mentionedUserIds?: string[] }
router.post(
  "/tasks/:taskId/comments",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const user = req.user as any;
      const { taskId } = req.params;
      const { text, mentionedTaskIds, mentionedUserIds } = req.body;
      if (!text || !String(text).trim()) {
        return res
          .status(400)
          .json({ success: false, error: { code: "MISSING_TEXT" } });
      }

      const activity = await storage.createTaskActivity({
        taskId,
        type: "task_comment",
        actorUserId: user.id,
        payload: {
          text: String(text),
          mentionedTaskIds: Array.isArray(mentionedTaskIds) ? mentionedTaskIds : [],
          mentionedUserIds: Array.isArray(mentionedUserIds) ? mentionedUserIds : [],
        },
      });

      return res.json({ success: true, data: activity });
    } catch (err: any) {
      return res
        .status(500)
        .json({ success: false, error: { code: "INTERNAL", message: err.message } });
    }
  },
);

export default router;

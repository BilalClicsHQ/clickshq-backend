/**
 * Jira Integration routes (space-level + task-level).
 *
 * Mounted at /api/integrations/jira.
 *
 *  Space-level:
 *    GET    /resources                          – List accessible Atlassian sites
 *    POST   /spaces/:spaceId/projects           – Connect a Jira project to a space
 *    GET    /spaces/:spaceId/projects           – List connected Jira projects
 *    DELETE /spaces/:spaceId/projects/:id       – Disconnect
 *    PATCH  /spaces/:spaceId/projects/:id       – Update auto-status mapping
 *
 *  Task-level:
 *    GET    /tasks/:taskId/links                – List Jira links on a task
 *    POST   /tasks/:taskId/links                – Manually link a Jira issue
 *    DELETE /tasks/:taskId/links/:linkId        – Unlink
 *    POST   /tasks/:taskId/issue                – Push task → new Jira issue
 *    POST   /spaces/:spaceId/import             – Bulk import Jira issues as tasks
 */
import { Router, Request, Response } from "express";
import { requireAuth } from "../auth";
import { storage } from "../storage";
import { getToken, getValidToken } from "../services/tokenService";
import {
  listAccessibleResources,
  listProjects,
  getProject,
  getIssue,
  searchIssues,
  createIssue,
  adfToText,
} from "../services/jiraService";

const router = Router();

function getCloudIdFromMetadata(metadata: string | null): string | null {
  if (!metadata) return null;
  try {
    return JSON.parse(metadata).cloudId || null;
  } catch {
    return null;
  }
}

async function getUserToken(userId: string): Promise<{ token: string; cloudId: string } | null> {
  // Use getValidToken which auto-refreshes expired Jira tokens (1h expiry)
  try {
    const t = await getValidToken(userId, "jira");
    const cloudId = getCloudIdFromMetadata(t.metadata ?? null);
    if (!cloudId) return null;
    return { token: t.accessToken, cloudId };
  } catch {
    return null;
  }
}

// ── List accessible sites ───────────────────────────────────────────────────
router.get("/resources", requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const t = await getToken(user.id, "jira");
    if (!t) {
      return res.status(403).json({ success: false, error: { code: "NOT_CONNECTED" } });
    }
    const resources = await listAccessibleResources(t.accessToken);
    return res.json({ success: true, data: resources });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: { code: "INTERNAL", message: err.message } });
  }
});

// ── Connect a Jira project to a space ───────────────────────────────────────
router.post(
  "/spaces/:spaceId/projects",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const user = req.user as any;
      const { spaceId } = req.params;
      const { projectKey } = req.body;
      if (!projectKey) {
        return res
          .status(400)
          .json({ success: false, error: { code: "MISSING_PROJECT_KEY" } });
      }

      const ctx = await getUserToken(user.id);
      if (!ctx) {
        return res
          .status(403)
          .json({ success: false, error: { code: "NOT_CONNECTED" } });
      }

      // Already connected?
      const existing = await storage.getSpaceJiraProjectByKey(spaceId, ctx.cloudId, projectKey);
      if (existing) {
        return res
          .status(409)
          .json({ success: false, error: { code: "ALREADY_CONNECTED" } });
      }

      // Fetch project details from Jira
      const proj: any = await getProject(ctx.token, ctx.cloudId, projectKey);

      // Build project URL
      const resources = await listAccessibleResources(ctx.token);
      const site = resources.find((r) => r.id === ctx.cloudId);
      const projectUrl = site ? `${site.url}/browse/${projectKey}` : undefined;

      const created = await storage.createSpaceJiraProject({
        spaceId,
        cloudId: ctx.cloudId,
        projectKey,
        projectId: String(proj.id),
        projectName: proj.name,
        projectUrl,
        connectedBy: user.id,
      });

      return res.json({ success: true, data: created });
    } catch (err: any) {
      return res
        .status(500)
        .json({ success: false, error: { code: "INTERNAL", message: err.message } });
    }
  },
);

// ── List connected projects for a space ─────────────────────────────────────
router.get(
  "/spaces/:spaceId/projects",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const { spaceId } = req.params;
      const projects = await storage.getSpaceJiraProjects(spaceId);
      return res.json({ success: true, data: projects });
    } catch (err: any) {
      return res
        .status(500)
        .json({ success: false, error: { code: "INTERNAL", message: err.message } });
    }
  },
);

// ── Update auto-status mapping ──────────────────────────────────────────────
router.patch(
  "/spaces/:spaceId/projects/:id",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const updated = await storage.updateSpaceJiraProject(id, {
        autoStatusOnInProgress: req.body.autoStatusOnInProgress,
        autoStatusOnDone: req.body.autoStatusOnDone,
        autoStatusOnBlocked: req.body.autoStatusOnBlocked,
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

// ── Disconnect a project ────────────────────────────────────────────────────
router.delete(
  "/spaces/:spaceId/projects/:id",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const ok = await storage.deleteSpaceJiraProject(id);
      return res.json({ success: ok });
    } catch (err: any) {
      return res
        .status(500)
        .json({ success: false, error: { code: "INTERNAL", message: err.message } });
    }
  },
);

// ── List Jira links on a task ───────────────────────────────────────────────
router.get(
  "/tasks/:taskId/links",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const { taskId } = req.params;
      const links = await storage.getTaskJiraLinks(taskId);
      return res.json({ success: true, data: links });
    } catch (err: any) {
      return res
        .status(500)
        .json({ success: false, error: { code: "INTERNAL", message: err.message } });
    }
  },
);

// ── Manually link a Jira issue to a task ────────────────────────────────────
router.post(
  "/tasks/:taskId/links",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const user = req.user as any;
      const { taskId } = req.params;
      const { issueKey } = req.body;
      if (!issueKey) {
        return res
          .status(400)
          .json({ success: false, error: { code: "MISSING_ISSUE_KEY" } });
      }

      const ctx = await getUserToken(user.id);
      if (!ctx) {
        return res
          .status(403)
          .json({ success: false, error: { code: "NOT_CONNECTED" } });
      }

      // Dedupe
      const existing = await storage.findTaskJiraLink(taskId, ctx.cloudId, issueKey);
      if (existing) {
        return res.json({ success: true, data: existing, deduped: true });
      }

      // Fetch issue details
      const issue: any = await getIssue(ctx.token, ctx.cloudId, issueKey);

      // Build issue URL
      const resources = await listAccessibleResources(ctx.token);
      const site = resources.find((r) => r.id === ctx.cloudId);
      const issueUrl = site ? `${site.url}/browse/${issueKey}` : `https://atlassian.net/browse/${issueKey}`;

      const created = await storage.createTaskJiraLink({
        taskId,
        cloudId: ctx.cloudId,
        issueKey,
        issueId: String(issue.id),
        issueUrl,
        summary: issue.fields?.summary,
        status: issue.fields?.status?.name,
        issueType: issue.fields?.issuetype?.name,
        priority: issue.fields?.priority?.name,
        assigneeName: issue.fields?.assignee?.displayName,
        assigneeAvatar: issue.fields?.assignee?.avatarUrls?.["24x24"],
        linkedBy: user.id,
        autoLinked: false,
      });

      await storage.createTaskActivity({
        taskId,
        type: "jira_issue_linked_manual",
        actorUserId: user.id,
        payload: { issueKey, issueUrl, summary: issue.fields?.summary },
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
      const ok = await storage.deleteTaskJiraLink(linkId);
      return res.json({ success: ok });
    } catch (err: any) {
      return res
        .status(500)
        .json({ success: false, error: { code: "INTERNAL", message: err.message } });
    }
  },
);

// ── Push task → Jira issue ──────────────────────────────────────────────────
router.post(
  "/tasks/:taskId/issue",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const user = req.user as any;
      const { taskId } = req.params;
      const { projectKey, summary, description, issueType, labels, priority } = req.body;
      if (!projectKey) {
        return res
          .status(400)
          .json({ success: false, error: { code: "MISSING_PROJECT_KEY" } });
      }

      const ctx = await getUserToken(user.id);
      if (!ctx) {
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

      const issueSummary = summary || task.name;
      const taskRef = task.shortId ? `\n\n— clicsHQ TASK-${task.shortId}` : "";
      // Strip HTML from description for Jira plain text
      const plainDesc = (description || task.description || "").replace(/<[^>]+>/g, "");
      const issueDescription = plainDesc + taskRef;

      const created: any = await createIssue(ctx.token, ctx.cloudId, {
        projectKey,
        summary: issueSummary,
        description: issueDescription,
        issueType,
        labels,
        priority,
      });

      // Build issue URL
      const resources = await listAccessibleResources(ctx.token);
      const site = resources.find((r) => r.id === ctx.cloudId);
      const issueUrl = site ? `${site.url}/browse/${created.key}` : "";

      // Auto-link back
      const link = await storage.createTaskJiraLink({
        taskId,
        cloudId: ctx.cloudId,
        issueKey: created.key,
        issueId: String(created.id),
        issueUrl,
        summary: issueSummary,
        issueType: issueType || "Task",
        linkedBy: user.id,
        autoLinked: false,
      });

      await storage.createTaskActivity({
        taskId,
        type: "jira_issue_created",
        actorUserId: user.id,
        payload: { issueKey: created.key, issueUrl, summary: issueSummary },
      });

      return res.json({ success: true, data: { issue: created, link } });
    } catch (err: any) {
      return res
        .status(500)
        .json({ success: false, error: { code: "INTERNAL", message: err.message } });
    }
  },
);

// ── Bulk import Jira issues into a space as clicsHQ tasks ───────────────────
router.post(
  "/spaces/:spaceId/import",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const user = req.user as any;
      const { spaceId } = req.params;
      const { issueKeys, projectKey, jql } = req.body;

      const ctx = await getUserToken(user.id);
      if (!ctx) {
        return res
          .status(403)
          .json({ success: false, error: { code: "NOT_CONNECTED" } });
      }

      // Resolve issues: explicit issueKeys, or JQL, or all from projectKey
      let issuesToImport: any[] = [];
      if (Array.isArray(issueKeys) && issueKeys.length > 0) {
        for (const key of issueKeys) {
          try {
            const issue = await getIssue(ctx.token, ctx.cloudId, key);
            issuesToImport.push(issue);
          } catch (e) {
            // Skip if not found
          }
        }
      } else if (jql || projectKey) {
        const finalJql = jql || `project = ${projectKey} ORDER BY created DESC`;
        const search = await searchIssues(ctx.token, ctx.cloudId, {
          jql: finalJql,
          maxResults: 50,
        });
        issuesToImport = search.issues ?? [];
      } else {
        return res
          .status(400)
          .json({ success: false, error: { code: "MISSING_FILTER" } });
      }

      // Find default status for the space (first one)
      const statuses = (await (storage as any).getSpaceStatuses?.(spaceId)) ?? [];
      const defaultStatusId = statuses[0]?.id;
      if (!defaultStatusId) {
        return res
          .status(400)
          .json({ success: false, error: { code: "NO_STATUSES", message: "Space has no statuses configured" } });
      }

      const resources = await listAccessibleResources(ctx.token);
      const site = resources.find((r) => r.id === ctx.cloudId);

      const imported: any[] = [];
      for (const issue of issuesToImport) {
        const summary = issue.fields?.summary ?? issue.key;
        const description = adfToText(issue.fields?.description);

        // Create clicsHQ task
        const newTask = await storage.createTask({
          spaceId,
          name: summary,
          description,
          statusId: defaultStatusId,
          priority: issue.fields?.priority?.name?.toLowerCase() || null,
          ownerId: user.id,
          assigneeIds: [],
          attachments: [],
          labels: issue.fields?.labels ?? [],
        });

        const issueUrl = site
          ? `${site.url}/browse/${issue.key}`
          : `https://atlassian.net/browse/${issue.key}`;

        // Auto-link the issue
        await storage.createTaskJiraLink({
          taskId: newTask.id,
          cloudId: ctx.cloudId,
          issueKey: issue.key,
          issueId: String(issue.id),
          issueUrl,
          summary,
          status: issue.fields?.status?.name,
          issueType: issue.fields?.issuetype?.name,
          priority: issue.fields?.priority?.name,
          assigneeName: issue.fields?.assignee?.displayName,
          assigneeAvatar: issue.fields?.assignee?.avatarUrls?.["24x24"],
          linkedBy: user.id,
          autoLinked: false,
        });

        await storage.createTaskActivity({
          taskId: newTask.id,
          type: "jira_issue_imported",
          actorUserId: user.id,
          payload: { issueKey: issue.key, issueUrl, summary },
        });

        imported.push({ task: newTask, issue });
      }

      return res.json({ success: true, data: { imported, count: imported.length } });
    } catch (err: any) {
      return res
        .status(500)
        .json({ success: false, error: { code: "INTERNAL", message: err.message } });
    }
  },
);

// ── Browse Jira projects (for connect modal) ────────────────────────────────
router.get("/browse/projects", requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const ctx = await getUserToken(user.id);
    if (!ctx) {
      return res
        .status(403)
        .json({ success: false, error: { code: "NOT_CONNECTED" } });
    }
    const projects = await listProjects(ctx.token, ctx.cloudId);
    return res.json({ success: true, data: projects });
  } catch (err: any) {
    return res
      .status(500)
      .json({ success: false, error: { code: "INTERNAL", message: err.message } });
  }
});

// ── Browse Jira issues (for link modal) ─────────────────────────────────────
router.get("/browse/issues", requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const ctx = await getUserToken(user.id);
    if (!ctx) {
      return res
        .status(403)
        .json({ success: false, error: { code: "NOT_CONNECTED" } });
    }
    const { projectKey, jql, query: q } = req.query;
    let finalJql = String(jql ?? "");
    if (!finalJql) {
      const parts: string[] = [];
      if (projectKey) parts.push(`project = "${projectKey}"`);
      if (q) {
        const qStr = String(q).trim();
        // Escape JQL special characters in query
        const safeQ = qStr.replace(/["\\]/g, "\\$&");
        // Detect if it looks like an issue key (e.g., KAN-1) or project prefix
        const keyMatch = qStr.match(/^([A-Z][A-Z0-9_]*)(-?(\d+))?$/i);
        if (keyMatch) {
          // Support: "KAN", "KAN-1", "kan-1"
          const upperKey = keyMatch[1].toUpperCase();
          if (keyMatch[3]) {
            // Exact issue key
            parts.push(`issuekey = "${upperKey}-${keyMatch[3]}"`);
          } else {
            // Project prefix - match all issues in that project + text search
            parts.push(`(project = "${upperKey}" OR text ~ "${safeQ}*" OR summary ~ "${safeQ}*")`);
          }
        } else {
          // Wildcard text/summary search for partial matches
          parts.push(`(summary ~ "${safeQ}*" OR text ~ "${safeQ}*" OR description ~ "${safeQ}*")`);
        }
      }
      finalJql = parts.length ? parts.join(" AND ") + " ORDER BY updated DESC" : "ORDER BY updated DESC";
    }
    const data = await searchIssues(ctx.token, ctx.cloudId, { jql: finalJql, maxResults: 30 });
    return res.json({ success: true, data: data.issues ?? [] });
  } catch (err: any) {
    return res
      .status(500)
      .json({ success: false, error: { code: "INTERNAL", message: err.message } });
  }
});

export default router;

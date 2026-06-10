/**
 * Jira Service — centralized Atlassian REST API client + helpers.
 *
 * Jira Cloud uses OAuth 2.0 (3LO). After OAuth, we have an access token
 * and the user's `cloudId` (Atlassian site ID) stored in token metadata.
 * Every API call must include the cloudId in the URL.
 *
 * Base URL: https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/
 */

export class JiraApiError extends Error {
  constructor(public status: number, message: string, public response?: any) {
    super(message);
  }
}

async function jira<T = any>(
  token: string,
  cloudId: string,
  endpoint: string,
  options: RequestInit = {},
): Promise<T> {
  const res = await fetch(
    `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3${endpoint}`,
    {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...options.headers,
      },
    },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new JiraApiError(
      res.status,
      (body as any).errorMessages?.[0] ||
        (body as any).message ||
        `Jira API error: ${res.status}`,
      body,
    );
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ── Accessible Resources (sites the user has access to) ─────────────────────
/**
 * Lists Atlassian sites the user has access to.
 * Returns array with `id` (cloudId) + `name` + `url` per site.
 */
export async function listAccessibleResources(token: string) {
  const res = await fetch("https://api.atlassian.com/oauth/token/accessible-resources", {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) throw new JiraApiError(res.status, "Failed to list resources");
  return (await res.json()) as Array<{
    id: string;
    name: string;
    url: string;
    scopes: string[];
  }>;
}

// ── User ────────────────────────────────────────────────────────────────────
export async function getMyself(token: string, cloudId: string) {
  return jira(token, cloudId, "/myself");
}

// ── Projects ────────────────────────────────────────────────────────────────
export async function listProjects(token: string, cloudId: string, maxResults = 50) {
  const data = await jira<{ values: any[] }>(
    token,
    cloudId,
    `/project/search?maxResults=${maxResults}&orderBy=name`,
  );
  return data.values ?? [];
}

export async function getProject(token: string, cloudId: string, projectKey: string) {
  return jira(token, cloudId, `/project/${projectKey}`);
}

// ── Issues ──────────────────────────────────────────────────────────────────
/**
 * Search issues using JQL. Uses the v3 `/search/jql` endpoint which replaced
 * the deprecated `/search` endpoint in late 2024. Falls back to `/search` for
 * older Jira sites.
 */
export async function searchIssues(
  token: string,
  cloudId: string,
  opts: { jql?: string; maxResults?: number; nextPageToken?: string; fields?: string[] } = {},
): Promise<{ issues: any[]; total?: number; nextPageToken?: string }> {
  const body: any = {
    jql: opts.jql ?? "ORDER BY updated DESC",
    maxResults: opts.maxResults ?? 50,
    fields: opts.fields ?? ["summary", "status", "issuetype", "priority", "assignee", "description", "labels", "components"],
  };
  if (opts.nextPageToken) body.nextPageToken = opts.nextPageToken;

  try {
    // New endpoint (post-2024)
    const data = await jira<{ issues: any[]; nextPageToken?: string }>(
      token,
      cloudId,
      `/search/jql`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );
    return { issues: data.issues ?? [], nextPageToken: data.nextPageToken };
  } catch (err: any) {
    // Fallback to legacy GET /search (some older sites)
    const params = new URLSearchParams({
      jql: body.jql,
      maxResults: String(body.maxResults),
    });
    if (opts.fields) params.set("fields", opts.fields.join(","));
    const data = await jira<{ issues: any[]; total: number }>(
      token,
      cloudId,
      `/search?${params.toString()}`,
    );
    return { issues: data.issues ?? [], total: data.total };
  }
}

export async function getIssue(token: string, cloudId: string, issueKey: string) {
  return jira(token, cloudId, `/issue/${issueKey}`);
}

export async function createIssue(
  token: string,
  cloudId: string,
  data: {
    projectKey: string;
    summary: string;
    description?: string;
    issueType?: string;
    labels?: string[];
    priority?: string;
  },
) {
  const payload: any = {
    fields: {
      project: { key: data.projectKey },
      summary: data.summary,
      issuetype: { name: data.issueType ?? "Task" },
    },
  };
  if (data.description) {
    // Jira uses Atlassian Document Format (ADF) for descriptions
    payload.fields.description = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: data.description }],
        },
      ],
    };
  }
  if (data.labels?.length) payload.fields.labels = data.labels;
  if (data.priority) payload.fields.priority = { name: data.priority };

  return jira<{ id: string; key: string; self: string }>(token, cloudId, "/issue", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function updateIssue(
  token: string,
  cloudId: string,
  issueKey: string,
  fields: Record<string, any>,
) {
  await jira(token, cloudId, `/issue/${issueKey}`, {
    method: "PUT",
    body: JSON.stringify({ fields }),
  });
}

// ── Transitions (status changes) ────────────────────────────────────────────
export async function listTransitions(token: string, cloudId: string, issueKey: string) {
  const data = await jira<{ transitions: any[] }>(
    token,
    cloudId,
    `/issue/${issueKey}/transitions`,
  );
  return data.transitions ?? [];
}

export async function transitionIssue(
  token: string,
  cloudId: string,
  issueKey: string,
  transitionId: string,
) {
  await jira(token, cloudId, `/issue/${issueKey}/transitions`, {
    method: "POST",
    body: JSON.stringify({ transition: { id: transitionId } }),
  });
}

// ── Webhooks ────────────────────────────────────────────────────────────────
/**
 * Default events for full feature coverage:
 *  - jira:issue_created
 *  - jira:issue_updated   (status changes, assignee changes, etc.)
 *  - jira:issue_deleted
 *  - comment_created      (issue activity)
 */
export const DEFAULT_JIRA_EVENTS = [
  "jira:issue_created",
  "jira:issue_updated",
  "jira:issue_deleted",
  "comment_created",
];

/**
 * Register a dynamic webhook for the connected user's Jira site.
 *
 * IMPORTANT: Jira's dynamic webhooks expire after 30 days unless refreshed.
 * They also have a different lifecycle than GitHub's per-repo webhooks.
 *
 * @param jqlFilter Filter events to specific projects (e.g. "project = ENG")
 */
export async function registerWebhook(
  token: string,
  cloudId: string,
  callbackUrl: string,
  events: string[],
  jqlFilter: string,
) {
  return jira<{ webhookRegistrationResult: any[] }>(
    token,
    cloudId,
    `/webhook`,
    {
      method: "POST",
      body: JSON.stringify({
        url: callbackUrl,
        webhooks: [
          {
            events,
            jqlFilter,
            fieldIdsFilter: [],
          },
        ],
      }),
    },
  );
}

export async function deleteWebhook(token: string, cloudId: string, webhookIds: number[]) {
  return jira(token, cloudId, "/webhook", {
    method: "DELETE",
    body: JSON.stringify({ webhookIds }),
  });
}

// ── Task Reference Parser ───────────────────────────────────────────────────
/**
 * Extract clicsHQ task references from Jira text (issue summary, description, comments).
 * Same pattern as GitHub parser — matches TASK-N, clicsHQ-N (case-insensitive).
 */
const TASK_REF_REGEX = /(?:#|\b)(?:task|clicshq)[-_]?(\d+)/gi;

export function parseTaskReferences(text: string | null | undefined): number[] {
  if (!text) return [];
  const ids = new Set<number>();
  for (const match of text.matchAll(TASK_REF_REGEX)) {
    const n = parseInt(match[1], 10);
    if (!Number.isNaN(n) && n > 0) ids.add(n);
  }
  return [...ids];
}

/**
 * Jira issue descriptions come in Atlassian Document Format (ADF).
 * This helper extracts plain text recursively.
 */
export function adfToText(adf: any): string {
  if (!adf) return "";
  if (typeof adf === "string") return adf;
  if (adf.type === "text") return adf.text ?? "";
  if (Array.isArray(adf.content)) return adf.content.map(adfToText).join(" ");
  if (Array.isArray(adf)) return adf.map(adfToText).join(" ");
  return "";
}

/**
 * GitHub Service — centralized GitHub REST API client + helpers.
 *
 * All outbound calls to api.github.com flow through this file. Webhook
 * installation, repo/PR/issue/commit operations, and the task-reference
 * parser live here so routes and the webhook handler share one source of
 * truth.
 */
import crypto from "node:crypto";

const GITHUB_API = "https://api.github.com";
const API_VERSION = "2022-11-28";
const USER_AGENT = "Nexus-App";

export class GitHubApiError extends Error {
  constructor(public status: number, message: string, public response?: any) {
    super(message);
  }
}

async function gh<T = any>(
  token: string,
  endpoint: string,
  options: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${GITHUB_API}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": USER_AGENT,
      "X-GitHub-Api-Version": API_VERSION,
      ...options.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new GitHubApiError(
      res.status,
      (body as any).message || `GitHub API error: ${res.status}`,
      body,
    );
  }
  // Some DELETE endpoints return 204 No Content
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ── User & Repos ────────────────────────────────────────────────────────────
export async function getAuthenticatedUser(token: string) {
  return gh(token, "/user");
}

export async function listUserRepos(
  token: string,
  opts: { page?: number; perPage?: number; sort?: string } = {},
) {
  const params = new URLSearchParams({
    page: String(opts.page ?? 1),
    per_page: String(opts.perPage ?? 30),
    sort: opts.sort ?? "updated",
    affiliation: "owner,collaborator,organization_member",
  });
  return gh<any[]>(token, `/user/repos?${params}`);
}

export async function getRepo(token: string, owner: string, repo: string) {
  return gh(token, `/repos/${owner}/${repo}`);
}

export async function getRepoPermissions(
  token: string,
  owner: string,
  repo: string,
): Promise<{ admin: boolean; push: boolean; pull: boolean }> {
  const data = await gh<any>(token, `/repos/${owner}/${repo}`);
  return data.permissions ?? { admin: false, push: false, pull: true };
}

// ── Branches ────────────────────────────────────────────────────────────────
export async function listBranches(token: string, owner: string, repo: string) {
  return gh<any[]>(token, `/repos/${owner}/${repo}/branches?per_page=100`);
}

export async function createBranch(
  token: string,
  owner: string,
  repo: string,
  branchName: string,
  sourceBranch = "main",
) {
  const sourceRef = await gh<any>(
    token,
    `/repos/${owner}/${repo}/git/ref/heads/${sourceBranch}`,
  );
  return gh(token, `/repos/${owner}/${repo}/git/refs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ref: `refs/heads/${branchName}`,
      sha: sourceRef.object.sha,
    }),
  });
}

// ── Pull Requests ───────────────────────────────────────────────────────────
export async function listPullRequests(
  token: string,
  owner: string,
  repo: string,
  opts: { state?: "open" | "closed" | "all"; page?: number } = {},
) {
  const params = new URLSearchParams({
    state: opts.state ?? "open",
    page: String(opts.page ?? 1),
    per_page: "30",
  });
  return gh<any[]>(token, `/repos/${owner}/${repo}/pulls?${params}`);
}

export async function getPullRequest(
  token: string,
  owner: string,
  repo: string,
  number: number,
) {
  return gh(token, `/repos/${owner}/${repo}/pulls/${number}`);
}

export async function createPullRequest(
  token: string,
  owner: string,
  repo: string,
  data: { title: string; head: string; base: string; body?: string },
) {
  return gh(token, `/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...data, body: data.body ?? "" }),
  });
}

// ── Issues ──────────────────────────────────────────────────────────────────
export async function listIssues(
  token: string,
  owner: string,
  repo: string,
  opts: { state?: "open" | "closed" | "all"; page?: number } = {},
) {
  const params = new URLSearchParams({
    state: opts.state ?? "open",
    page: String(opts.page ?? 1),
    per_page: "30",
  });
  return gh<any[]>(token, `/repos/${owner}/${repo}/issues?${params}`);
}

export async function getIssue(
  token: string,
  owner: string,
  repo: string,
  number: number,
) {
  return gh(token, `/repos/${owner}/${repo}/issues/${number}`);
}

export async function createIssue(
  token: string,
  owner: string,
  repo: string,
  data: {
    title: string;
    body?: string;
    labels?: string[];
    assignees?: string[];
  },
) {
  return gh(token, `/repos/${owner}/${repo}/issues`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: data.title,
      body: data.body ?? "",
      labels: data.labels ?? [],
      assignees: data.assignees ?? [],
    }),
  });
}

// ── Commits ─────────────────────────────────────────────────────────────────
export async function listCommits(
  token: string,
  owner: string,
  repo: string,
  opts: { sha?: string; page?: number } = {},
) {
  const params = new URLSearchParams({
    sha: opts.sha ?? "main",
    page: String(opts.page ?? 1),
    per_page: "30",
  });
  return gh<any[]>(token, `/repos/${owner}/${repo}/commits?${params}`);
}

export async function getCommit(
  token: string,
  owner: string,
  repo: string,
  ref: string,
) {
  return gh(token, `/repos/${owner}/${repo}/commits/${ref}`);
}

// ── Organizations ───────────────────────────────────────────────────────────
export async function listOrgs(token: string) {
  return gh<any[]>(token, "/user/orgs");
}

// ── Webhooks (the heart of inbound integration) ─────────────────────────────
/**
 * Default events we want delivered for full feature coverage:
 *  - pull_request       (open/close/merge → status sync + linking)
 *  - pull_request_review (PR reviews → activity feed)
 *  - push               (commits → ref parsing + linking)
 *  - issues             (issue events → activity feed)
 *  - issue_comment      (PR / issue comments → activity feed)
 */
export const DEFAULT_WEBHOOK_EVENTS = [
  "pull_request",
  "pull_request_review",
  "push",
  "issues",
  "issue_comment",
];

/**
 * Install a repo webhook pointing at our public webhook URL. Caller must
 * generate and persist the `secret` — GitHub will sign every payload with it.
 */
export async function installWebhook(
  token: string,
  owner: string,
  repo: string,
  callbackUrl: string,
  secret: string,
  events: string[] = DEFAULT_WEBHOOK_EVENTS,
) {
  return gh<{ id: number; url: string; active: boolean }>(
    token,
    `/repos/${owner}/${repo}/hooks`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "web",
        active: true,
        events,
        config: {
          url: callbackUrl,
          content_type: "json",
          secret,
          insecure_ssl: "0",
        },
      }),
    },
  );
}

export async function uninstallWebhook(
  token: string,
  owner: string,
  repo: string,
  webhookId: number,
) {
  return gh(token, `/repos/${owner}/${repo}/hooks/${webhookId}`, {
    method: "DELETE",
  });
}

export function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Verify GitHub's X-Hub-Signature-256 header using HMAC-SHA256.
 * Constant-time comparison to prevent timing attacks.
 *
 * IMPORTANT: rawBody must be the EXACT raw body bytes, not parsed/re-serialised JSON.
 */
export function verifyWebhookSignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) return false;
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ── Task Reference Parser ───────────────────────────────────────────────────
/**
 * Extracts clicsHQ task references from arbitrary text (commit messages,
 * PR titles, PR bodies, branch names, comments).
 *
 * Matches: TASK-123 (case-insensitive), with optional # prefix.
 * Also supports clicsHQ-123 as alias.
 *
 * Returns deduplicated array of numeric short IDs.
 *
 * Examples:
 *   "Fix login bug #TASK-42" → [42]
 *   "Implement TASK-7 and TASK-9" → [7, 9]
 *   "feat/task-15-add-billing" → [15]
 *   "Closes #TASK-3, fixes #task-3" → [3]
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
 * Parse refs from multiple text sources at once. Useful for PRs:
 * title + body + branch name + commits collectively.
 */
export function parseTaskReferencesMulti(
  ...texts: (string | null | undefined)[]
): number[] {
  const ids = new Set<number>();
  for (const t of texts) {
    for (const id of parseTaskReferences(t)) ids.add(id);
  }
  return [...ids];
}

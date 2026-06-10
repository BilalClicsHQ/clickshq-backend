/**
 * Figma Service — REST API client + URL parser for design embeds.
 *
 * OAuth token is stored under provider 'figma' in user_integrations.
 */

const API_BASE = "https://api.figma.com/v1";

export class FigmaApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function figma<T = any>(token: string, endpoint: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new FigmaApiError(res.status, (body as any).err || `Figma API error: ${res.status}`);
  }
  return (await res.json()) as T;
}

// ─── User info ─────────────────────────────────────────────────────────────
export async function getFigmaUser(token: string) {
  return figma(token, "/me");
}

// ─── File metadata ─────────────────────────────────────────────────────────
export async function getFigmaFile(token: string, fileKey: string) {
  return figma<{
    name: string;
    lastModified: string;
    thumbnailUrl: string;
    document: any;
  }>(token, `/files/${fileKey}?depth=1`);
}

// ─── Render single frame/node as PNG ───────────────────────────────────────
export async function renderFigmaNode(
  token: string,
  fileKey: string,
  nodeId: string,
  format: "png" | "svg" | "jpg" | "pdf" = "png",
  scale = 2,
): Promise<string | null> {
  const params = new URLSearchParams({
    ids: nodeId,
    format,
    scale: String(scale),
  });
  const data = await figma<{ images: Record<string, string | null> }>(
    token,
    `/images/${fileKey}?${params.toString()}`,
  );
  return data.images?.[nodeId] ?? null;
}

// ─── URL Parser ────────────────────────────────────────────────────────────
/**
 * Parse a Figma file URL into { fileKey, nodeId, fileName }.
 *
 * Supported URL formats:
 *   https://www.figma.com/file/{fileKey}/{fileName}
 *   https://www.figma.com/file/{fileKey}/{fileName}?node-id=1%3A2
 *   https://www.figma.com/design/{fileKey}/{fileName}?node-id=1-2
 *   https://www.figma.com/proto/{fileKey}/{fileName}
 *   https://www.figma.com/board/{fileKey}/{fileName} (FigJam)
 */
export function parseFigmaUrl(url: string): { fileKey: string; nodeId: string | null; fileName: string | null } | null {
  try {
    const u = new URL(url);
    if (!u.hostname.includes("figma.com")) return null;
    // Path: /file/{key}/{name} | /design/{key}/{name} | /proto/{key}/{name} | /board/{key}/{name}
    const match = u.pathname.match(/^\/(file|design|proto|board)\/([a-zA-Z0-9]+)(?:\/(.+))?$/);
    if (!match) return null;
    const fileKey = match[2];
    const fileName = match[3] ? decodeURIComponent(match[3]).replace(/-/g, " ") : null;
    // node-id can be `1:2` (URL encoded as `1%3A2`) or `1-2` (newer format)
    let nodeId = u.searchParams.get("node-id");
    if (nodeId) {
      // Normalize "1-2" → "1:2" (Figma API expects colon form)
      nodeId = nodeId.replace(/-/g, ":");
    }
    return { fileKey, nodeId, fileName };
  } catch {
    return null;
  }
}

/**
 * Build the canonical Figma embed URL for an iframe.
 * Figma provides a public embed page that works without authentication
 * for files with public sharing enabled.
 */
export function buildFigmaEmbedUrl(fileKey: string, nodeId: string | null): string {
  const inner = `https://www.figma.com/file/${fileKey}/`;
  const params = new URLSearchParams({ url: inner });
  if (nodeId) params.set("node-id", nodeId);
  return `https://www.figma.com/embed?embed_host=clicshq&${params.toString()}`;
}

/**
 * Build the original "open in Figma" URL.
 */
export function buildFigmaFileUrl(fileKey: string, nodeId: string | null, fileName: string | null = null): string {
  const namePart = fileName ? encodeURIComponent(fileName) : "Untitled";
  const base = `https://www.figma.com/file/${fileKey}/${namePart}`;
  return nodeId ? `${base}?node-id=${encodeURIComponent(nodeId)}` : base;
}

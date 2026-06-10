/**
 * Dropbox Service — wraps Dropbox REST APIs.
 *
 * Two API hosts:
 *   - api.dropboxapi.com   — JSON metadata operations (list, search, get)
 *   - content.dropboxapi.com — file download/upload (we don't use here)
 */

const API_BASE = "https://api.dropboxapi.com/2";

export class DropboxApiError extends Error {
  constructor(public status: number, message: string, public response?: any) {
    super(message);
  }
}

async function dbx<T = any>(
  token: string,
  endpoint: string,
  body: any = null,
): Promise<T> {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body == null ? "null" : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new DropboxApiError(res.status, `Dropbox API error: ${res.status} — ${text}`);
  }
  // Dropbox returns JSON for all 2xx, empty for some
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) return undefined as T;
  return (await res.json()) as T;
}

// ─── List files in folder ──────────────────────────────────────────────────
export async function listDropboxFiles(
  token: string,
  opts: { path?: string; limit?: number } = {},
) {
  // Dropbox API quirk: root path must be empty string "", NOT "/"
  // Subfolder paths must start with "/" (e.g. "/Pictures")
  let path = opts.path ?? "";
  if (path === "/") path = "";
  const data = await dbx<{ entries: any[]; has_more: boolean; cursor?: string }>(
    token,
    "/files/list_folder",
    {
      path,
      recursive: false,
      include_media_info: true,
      include_deleted: false,
      include_has_explicit_shared_members: false,
      limit: opts.limit ?? 100,
    },
  );
  console.log(`[Dropbox] listDropboxFiles path="${path}" → ${data.entries?.length ?? 0} entries`);
  return data.entries ?? [];
}

// ─── Search files ──────────────────────────────────────────────────────────
export async function searchDropbox(token: string, query: string, limit = 50) {
  const data = await dbx<{ matches: any[] }>(token, "/files/search_v2", {
    query,
    options: { max_results: limit, file_status: "active" },
  });
  return (data.matches ?? []).map((m: any) => m.metadata?.metadata).filter(Boolean);
}

// ─── Get file metadata (normalized for attachments) ────────────────────────
export async function getDropboxFileMetadata(token: string, fileIdOrPath: string) {
  // Dropbox accepts both ids (id:abc) and paths (/path/to/file)
  const isId = fileIdOrPath.startsWith("id:");
  const file: any = await dbx(token, "/files/get_metadata", {
    path: fileIdOrPath,
    include_media_info: true,
  });

  // Generate a shared link for viewing
  let viewUrl: string | null = null;
  let embedUrl: string | null = null;
  try {
    const link: any = await dbx(token, "/sharing/create_shared_link_with_settings", {
      path: file.path_lower || file.path_display || fileIdOrPath,
      settings: { requested_visibility: "public" },
    });
    viewUrl = link.url ?? null;
    embedUrl = toDropboxEmbedUrl(viewUrl);
  } catch (err: any) {
    // If shared link already exists, listing it
    try {
      const links: any = await dbx(token, "/sharing/list_shared_links", {
        path: file.path_lower || file.path_display || fileIdOrPath,
        direct_only: true,
      });
      viewUrl = links.links?.[0]?.url ?? null;
      embedUrl = toDropboxEmbedUrl(viewUrl);
    } catch {
      // Ignore — file can still be attached without shareable link
    }
  }

  return {
    id: file.id || isId ? fileIdOrPath : file.path_lower || fileIdOrPath,
    name: file.name ?? "Untitled",
    mimeType: null, // Dropbox doesn't return MIME type — could infer from extension
    size: file.size ?? null,
    externalUrl: viewUrl,
    downloadUrl: viewUrl ? viewUrl.replace(/\?dl=0$/, "?dl=1").replace(/(\?|&)st=[^&]+&?/, "$1") : null,
    embedUrl,
    iconUrl: null,
    thumbnailUrl: null,
    ownerName: null,
    modifiedAt: file.server_modified ? new Date(file.server_modified) : file.client_modified ? new Date(file.client_modified) : null,
    metadata: { path: file.path_display, rev: file.rev },
  };
}

// ─── Get a temporary preview link (for inline iframe) ──────────────────────
export async function getDropboxTemporaryLink(token: string, path: string): Promise<string | null> {
  try {
    const data: any = await dbx(token, "/files/get_temporary_link", { path });
    return data.link ?? null;
  } catch {
    return null;
  }
}

/**
 * Convert a Dropbox sharing URL into an embeddable URL.
 *
 * Dropbox's standard `www.dropbox.com/scl/...?dl=0` URLs return X-Frame-Options
 * headers that block iframe embedding. To get an iframe-friendly preview:
 *   - For PDFs/images: switch host to `dl.dropboxusercontent.com` and ?raw=1
 *     (returns raw file content with CORS-friendly headers).
 *   - For other types: Dropbox does not provide an embed iframe; fall back to
 *     the original URL — the preview component will show a "open in source" link.
 */
function toDropboxEmbedUrl(viewUrl: string | null): string | null {
  if (!viewUrl) return null;
  try {
    const url = new URL(viewUrl);
    // Force download host for raw streaming
    url.hostname = "dl.dropboxusercontent.com";
    // Strip dl=0 / dl=1, set raw=1
    url.searchParams.delete("dl");
    url.searchParams.set("raw", "1");
    return url.toString();
  } catch {
    return viewUrl;
  }
}

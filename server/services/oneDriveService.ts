/**
 * OneDrive Service — wraps Microsoft Graph file APIs.
 *
 * Authentication: OAuth bearer token from `user_integrations` (provider 'onedrive').
 * Base URL: https://graph.microsoft.com/v1.0
 */

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export class OneDriveApiError extends Error {
  constructor(public status: number, message: string, public response?: any) {
    super(message);
  }
}

async function graph<T = any>(
  token: string,
  endpoint: string,
  options: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${GRAPH_BASE}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new OneDriveApiError(
      res.status,
      (body as any).error?.message || `OneDrive API error: ${res.status}`,
      body,
    );
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ─── List files ────────────────────────────────────────────────────────────
export async function listOneDriveFiles(
  token: string,
  opts: { folderId?: string; top?: number; search?: string } = {},
) {
  const top = opts.top ?? 50;
  let path: string;
  if (opts.search) {
    path = `/me/drive/root/search(q='${encodeURIComponent(opts.search)}')?$top=${top}`;
  } else if (opts.folderId) {
    path = `/me/drive/items/${opts.folderId}/children?$top=${top}&$orderby=lastModifiedDateTime desc`;
  } else {
    path = `/me/drive/root/children?$top=${top}&$orderby=lastModifiedDateTime desc`;
  }
  const data = await graph<{ value: any[] }>(token, path);
  return data.value ?? [];
}

// ─── Get file metadata (normalized for attachments) ────────────────────────
export async function getOneDriveFileMetadata(token: string, fileId: string) {
  const file: any = await graph(
    token,
    `/me/drive/items/${fileId}?$select=id,name,size,file,webUrl,thumbnails,createdBy,lastModifiedDateTime,@microsoft.graph.downloadUrl`,
  );

  // OneDrive's web embed pattern: append ?web=1 to viewable office docs,
  // or use createLink for an embed link
  const externalUrl = file.webUrl ?? null;
  const embedUrl = externalUrl
    ? externalUrl.replace(/(\?|$)/, "?web=1$1").replace(/\?$/, "")
    : null;

  return {
    id: file.id,
    name: file.name ?? "Untitled",
    mimeType: file.file?.mimeType ?? null,
    size: file.size ?? null,
    externalUrl,
    downloadUrl: file["@microsoft.graph.downloadUrl"] ?? null,
    embedUrl,
    iconUrl: null,
    thumbnailUrl: file.thumbnails?.[0]?.medium?.url ?? null,
    ownerName: file.createdBy?.user?.displayName ?? null,
    modifiedAt: file.lastModifiedDateTime ? new Date(file.lastModifiedDateTime) : null,
  };
}

// ─── Create an embed/preview link (for inline preview) ─────────────────────
export async function createOneDriveEmbedLink(token: string, fileId: string): Promise<string | null> {
  try {
    const data: any = await graph(token, `/me/drive/items/${fileId}/createLink`, {
      method: "POST",
      body: JSON.stringify({ type: "embed", scope: "anonymous" }),
    });
    return data.link?.webUrl ?? null;
  } catch (err) {
    // createLink can fail on personal accounts — gracefully fall back
    return null;
  }
}

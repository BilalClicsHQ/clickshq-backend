import { google, drive_v3 } from 'googleapis';
import { Readable } from 'stream';

// ─── Types ───────────────────────────────────────────────────────────────────
export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size: string | null;
  modifiedTime: string;
  webViewLink: string | null;
  iconLink: string | null;
  parents: string[] | null;
}

export interface DriveFileList {
  files: DriveFile[];
  nextPageToken: string | null;
}

export interface DriveFolder {
  id: string;
  name: string;
  webViewLink: string | null;
}

// ─── Drive Client Factory ────────────────────────────────────────────────────
// Creates an authenticated Drive client per request.
function createDriveClient(accessToken: string, refreshToken?: string | null): drive_v3.Drive {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  oauth2Client.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken ?? undefined,
  });

  return google.drive({ version: 'v3', auth: oauth2Client });
}

// ─── List Files ──────────────────────────────────────────────────────────────
// Lists files in the user's Drive (or specific folder).
export async function listFiles(
  accessToken: string,
  options?: {
    refreshToken?: string | null;
    folderId?: string;
    pageSize?: number;
    pageToken?: string;
    query?: string;
    mimeType?: string; // exact mime type filter (e.g. 'application/vnd.google-apps.document')
  }
): Promise<DriveFileList> {
  const drive = createDriveClient(accessToken, options?.refreshToken);

  // Build query
  const queryParts: string[] = ['trashed = false'];
  if (options?.folderId) {
    queryParts.push(`'${options.folderId}' in parents`);
  }
  if (options?.query) {
    queryParts.push(`name contains '${options.query.replace(/'/g, "\\'")}'`);
  }
  if (options?.mimeType) {
    queryParts.push(`mimeType = '${options.mimeType.replace(/'/g, "\\'")}'`);
  }

  // Include files owned by the user AND files shared with them.
  // Without `corpora: 'allDrives'` + supportsAllDrives, Drive only returns My Drive
  // by default. We use the broader query and combined corpora for full visibility.
  const response = await drive.files.list({
    q: queryParts.join(' and '),
    pageSize: options?.pageSize || 25,
    pageToken: options?.pageToken || undefined,
    fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime, webViewLink, iconLink, parents, ownedByMe, shared)',
    orderBy: 'modifiedTime desc',
    corpora: 'user',
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
    spaces: 'drive',
  });

  const files: DriveFile[] = (response.data.files || []).map((f) => ({
    id: f.id!,
    name: f.name!,
    mimeType: f.mimeType!,
    size: f.size ?? null,
    modifiedTime: f.modifiedTime!,
    webViewLink: f.webViewLink ?? null,
    iconLink: f.iconLink ?? null,
    parents: (f.parents as string[]) ?? null,
  }));

  return {
    files,
    nextPageToken: response.data.nextPageToken ?? null,
  };
}

// ─── Upload File ─────────────────────────────────────────────────────────────
// Uploads a file to Drive (optionally into a specific folder).
export async function uploadFile(
  accessToken: string,
  file: {
    name: string;
    mimeType: string;
    buffer: Buffer;
    folderId?: string;
  },
  refreshToken?: string | null
): Promise<DriveFile> {
  const drive = createDriveClient(accessToken, refreshToken);

  const fileMetadata: any = { name: file.name };
  if (file.folderId) {
    fileMetadata.parents = [file.folderId];
  }

  const response = await drive.files.create({
    requestBody: fileMetadata,
    media: {
      mimeType: file.mimeType,
      body: Readable.from(file.buffer),
    },
    fields: 'id, name, mimeType, size, modifiedTime, webViewLink, iconLink, parents',
  });

  const f = response.data;
  return {
    id: f.id!,
    name: f.name!,
    mimeType: f.mimeType!,
    size: f.size ?? null,
    modifiedTime: f.modifiedTime!,
    webViewLink: f.webViewLink ?? null,
    iconLink: f.iconLink ?? null,
    parents: (f.parents as string[]) ?? null,
  };
}

// ─── Create Folder ───────────────────────────────────────────────────────────
// Creates a folder in Drive (optionally under a parent folder).
export async function createFolder(
  accessToken: string,
  folderName: string,
  parentFolderId?: string,
  refreshToken?: string | null
): Promise<DriveFolder> {
  const drive = createDriveClient(accessToken, refreshToken);

  const fileMetadata: any = {
    name: folderName,
    mimeType: 'application/vnd.google-apps.folder',
  };
  if (parentFolderId) {
    fileMetadata.parents = [parentFolderId];
  }

  const response = await drive.files.create({
    requestBody: fileMetadata,
    fields: 'id, name, webViewLink',
  });

  return {
    id: response.data.id!,
    name: response.data.name!,
    webViewLink: response.data.webViewLink ?? null,
  };
}

// ─── Share File ──────────────────────────────────────────────────────────────
// Shares a file with another user by email.
export async function shareFile(
  accessToken: string,
  fileId: string,
  email: string,
  role: 'reader' | 'writer' | 'commenter' = 'reader',
  refreshToken?: string | null
): Promise<{ permissionId: string }> {
  const drive = createDriveClient(accessToken, refreshToken);

  const response = await drive.permissions.create({
    fileId,
    requestBody: {
      type: 'user',
      role,
      emailAddress: email,
    },
    sendNotificationEmail: true,
  });

  return { permissionId: response.data.id! };
}

// ─── Get File Preview Link ───────────────────────────────────────────────────
// Returns preview metadata for a Drive file.
export interface DriveFilePreview {
  webViewLink: string | null;
  embedLink: string | null;
  thumbnailLink: string | null;
  name: string | null;
  mimeType: string | null;
}

export async function getFilePreview(
  accessToken: string,
  fileId: string,
  refreshToken?: string | null
): Promise<DriveFilePreview> {
  const drive = createDriveClient(accessToken, refreshToken);

  const response = await drive.files.get({
    fileId,
    fields: 'webViewLink, thumbnailLink, name, mimeType',
  });

  // Build embed link for Google Workspace files
  const webViewLink = response.data.webViewLink ?? null;
  let embedLink: string | null = null;
  if (webViewLink) {
    embedLink = webViewLink.replace(/\/edit.*$/, '/preview');
  }

  return {
    webViewLink,
    embedLink,
    thumbnailLink: response.data.thumbnailLink ?? null,
    name: response.data.name ?? null,
    mimeType: response.data.mimeType ?? null,
  };
}

// ─── Delete File ─────────────────────────────────────────────────────────────
// Moves a file to trash (not permanent delete).
export async function trashFile(
  accessToken: string,
  fileId: string,
  refreshToken?: string | null
): Promise<void> {
  const drive = createDriveClient(accessToken, refreshToken);

  await drive.files.update({
    fileId,
    requestBody: { trashed: true },
  });
}

// ─── Normalized File Metadata (for attachments) ─────────────────────────────
/**
 * Fetches full metadata for a single Drive file, returning a normalized object
 * suitable for storing as a TaskFileAttachment.
 */
export async function getDriveFileMetadata(
  accessToken: string,
  fileId: string,
  refreshToken?: string | null,
) {
  const drive = createDriveClient(accessToken, refreshToken);
  const { data } = await drive.files.get({
    fileId,
    fields: "id, name, mimeType, size, webViewLink, webContentLink, iconLink, thumbnailLink, modifiedTime, owners(displayName)",
  });

  const webViewLink = data.webViewLink ?? null;
  const embedUrl = webViewLink ? webViewLink.replace(/\/edit.*$/, "/preview") : null;

  return {
    id: data.id!,
    name: data.name ?? "Untitled",
    mimeType: data.mimeType ?? null,
    size: data.size ? parseInt(data.size, 10) : null,
    externalUrl: webViewLink,
    downloadUrl: data.webContentLink ?? null,
    embedUrl,
    iconUrl: data.iconLink ?? null,
    thumbnailUrl: data.thumbnailLink ?? null,
    ownerName: data.owners?.[0]?.displayName ?? null,
    modifiedAt: data.modifiedTime ? new Date(data.modifiedTime) : null,
  };
}

// ─── Export Google Doc as HTML (for clicsHQ Docs import) ───────────────────
/**
 * Google Workspace files (Docs, Sheets, Slides) can be exported in various
 * formats. For clicsHQ Docs import we want HTML which preserves formatting.
 */
export async function exportGoogleDocAsHtml(
  accessToken: string,
  fileId: string,
  refreshToken?: string | null,
): Promise<string> {
  const drive = createDriveClient(accessToken, refreshToken);
  const res = await drive.files.export(
    { fileId, mimeType: "text/html" },
    { responseType: "text" },
  );
  return (res.data as unknown as string) ?? "";
}

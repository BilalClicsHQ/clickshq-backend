import { versionStorage } from "../../storage/versionStorage";
import type { Document } from "@shared/schema";

const VERSION_THROTTLE_MS = 30 * 1000; // 30 seconds

/**
 * Extract word count from TipTap HTML content string
 */
function getWordCount(content: string | null): number {
  if (!content) return 0;
  // Strip HTML tags and count words
  const text = content.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return 0;
  return text.split(" ").length;
}

/**
 * Create an auto-version snapshot only if enough time has passed since the last version.
 * This prevents creating a version on every 2-second autosave.
 */
export async function maybeCreateAutoVersion(doc: Document, userId: string): Promise<void> {
  try {
    console.log(`[VersionHelper] maybeCreateAutoVersion called for doc ${doc.id} by user ${userId}`);
    const latest = await versionStorage.getLatestVersion(doc.id);

    if (latest?.createdAt) {
      const elapsed = Date.now() - new Date(latest.createdAt).getTime();
      console.log(`[VersionHelper] Last version was ${elapsed}ms ago (throttle: ${VERSION_THROTTLE_MS}ms)`);
      if (elapsed < VERSION_THROTTLE_MS) {
        console.log(`[VersionHelper] Skipping — too recent`);
        return;
      }
    } else {
      console.log(`[VersionHelper] No previous version found — creating first version`);
    }

    const nextVersion = await versionStorage.getNextVersionNumber(doc.id);
    console.log(`[VersionHelper] Creating version #${nextVersion} for doc ${doc.id}`);
    await versionStorage.createDocumentVersion({
      documentId: doc.id,
      title: doc.title,
      content: doc.content || "",
      createdBy: userId,
      versionNumber: nextVersion,
      changeType: "auto",
      wordCount: getWordCount(doc.content),
    });
    console.log(`[VersionHelper] Version #${nextVersion} created successfully`);
  } catch (error) {
    console.error("[VersionHelper] Failed to create auto version:", error);
  }
}

/**
 * Always create a manual version snapshot (e.g., user clicked "Save version")
 */
export async function createManualVersion(doc: Document, userId: string, changeType: string = "manual"): Promise<void> {
  const nextVersion = await versionStorage.getNextVersionNumber(doc.id);
  await versionStorage.createDocumentVersion({
    documentId: doc.id,
    title: doc.title,
    content: doc.content || "",
    createdBy: userId,
    versionNumber: nextVersion,
    changeType,
    wordCount: getWordCount(doc.content),
  });
}

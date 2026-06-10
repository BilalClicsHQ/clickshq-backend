import type { Request, Response } from "express";
import { documentStorage as storage } from "../../storage/documentStorage";

/**
 * Get all documents with optional filter
 * GET /api/docs?filter=my|meeting_notes|shared
 */
export async function getAllDocsHandler(req: Request, res: Response) {
  try {
    const userId = (req.user as any)?.id;
    const { filter } = req.query;
    console.log("[GetDocs] Filter:", filter, "User:", userId);

    let docs;
    if (filter === 'my') {
      docs = await storage.getDocumentsByOwner(userId);
    } else if (filter === 'meeting_notes') {
      // Get meeting notes only for the current user (owned + shared)
      const ownedMeetingNotes = (await storage.getDocumentsByCategory('meeting_notes'))
        .filter(doc => doc.ownerId === userId);
      const sharedMeetingNotes = (await storage.getDocumentsSharedWithUser(userId))
        .filter(doc => doc.category === 'meeting_notes');
      docs = [...ownedMeetingNotes, ...sharedMeetingNotes];
    } else if (filter === 'shared') {
      // Get only documents shared with me
      docs = await storage.getDocumentsSharedWithUser(userId);
    } else {
      // Default: show user's own documents + documents shared with them
      const ownedDocs = await storage.getDocumentsByOwner(userId);
      const sharedDocs = await storage.getDocumentsSharedWithUser(userId);
      docs = [...ownedDocs, ...sharedDocs];
    }

    console.log("[GetDocs] Found:", docs.length, "documents");
    // Log isPinned status for debugging
    docs.forEach((doc: any) => {
      if (doc.isPinned) {
        console.log("[GetDocs] Pinned doc:", doc.id, doc.title, "isPinned:", doc.isPinned);
      }
    });
    res.json(docs);
  } catch (error) {
    console.error("[GetDocs] Error:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ message: "Failed to fetch documents", error: errorMessage });
  }
}

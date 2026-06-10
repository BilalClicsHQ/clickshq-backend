import type { Request, Response } from "express";
import { documentStorage as storage } from "../../storage/documentStorage";

/**
 * Get soft-deleted documents for the current user (trash view)
 * GET /api/docs/trash
 */
export async function getTrashHandler(req: Request, res: Response) {
  try {
    const userId = (req.user as any)?.id;
    if (!userId) {
      res.status(401).json({ message: "Authentication required" });
      return;
    }

    const deletedDocs = await storage.getDeletedDocumentsByOwner(userId);
    res.json(deletedDocs);
  } catch (error) {
    console.error("Error fetching trash:", error);
    res.status(500).json({ message: "Failed to fetch trash" });
  }
}

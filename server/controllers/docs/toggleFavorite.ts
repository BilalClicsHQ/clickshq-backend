import type { Request, Response } from "express";
import { documentStorage as storage } from "../../storage/documentStorage";

/**
 * Toggle favorite status of a document
 * PATCH /api/docs/:id/favorite
 */
export async function toggleFavoriteHandler(req: Request, res: Response) {
  try {
    const { isFavorite } = req.body;

    const doc = await storage.updateDocument(req.params.id, { isFavorite });

    if (!doc) {
      res.status(404).json({ message: "Document not found" });
      return;
    }

    res.json({ id: doc.id, isFavorite: doc.isFavorite });
  } catch (error) {
    console.error("Error toggling favorite:", error);
    res.status(500).json({ message: "Failed to toggle favorite" });
  }
}

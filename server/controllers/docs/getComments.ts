import type { Request, Response } from "express";
import { documentStorage as storage } from "../../storage/documentStorage";

/**
 * Get all comments for a document
 * GET /api/docs/:id/comments
 */
export async function getCommentsHandler(req: Request, res: Response) {
  try {
    const comments = await storage.getDocumentComments(req.params.id);
    res.json(comments);
  } catch (error) {
    console.error("Error fetching comments:", error);
    res.status(500).json({ message: "Failed to fetch comments" });
  }
}

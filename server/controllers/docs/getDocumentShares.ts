import type { Request, Response } from "express";
import { documentStorage as storage } from "../../storage/documentStorage";

/**
 * Get all shares for a document
 * GET /api/docs/:documentId/shares
 */
export async function getDocumentSharesHandler(req: Request, res: Response) {
  try {
    const { documentId } = req.params;
    const shares = await storage.getDocumentShares(documentId);
    res.json(shares);
  } catch (error) {
    console.error("Error fetching document shares:", error);
    res.status(500).json({ message: "Failed to fetch document shares" });
  }
}

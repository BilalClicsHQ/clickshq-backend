import type { Request, Response } from "express";
import { documentStorage as storage } from "../../storage/documentStorage";

/**
 * Search users for sharing (autocomplete)
 * GET /api/users/search?q=query
 *
 * Uses database-level search for better performance instead of
 * fetching all users and filtering in memory.
 */
export async function searchUsersForSharingHandler(req: Request, res: Response) {
  try {
    const userId = (req.user as any)?.id;
    const { q, limit } = req.query;

    if (!q || typeof q !== 'string' || q.length < 2) {
      return res.json([]);
    }

    // Use database-level search (more performant than getAllUsers + filter)
    const maxResults = limit ? Math.min(parseInt(limit as string, 10), 20) : 10;
    const users = await storage.searchUsers(q, userId, maxResults);

    res.json(users);
  } catch (error) {
    console.error("Error searching users:", error);
    res.status(500).json({ message: "Failed to search users" });
  }
}

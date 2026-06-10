import type { Request, Response } from "express";
import { documentStorage as storage } from "../../storage/documentStorage";
import type { PaginationOptions } from "../../storage/documentStorage";

/**
 * Get documents with pagination and server-side filtering/sorting
 * GET /api/docs/paginated?page=1&limit=20&sortField=updated_at&sortDirection=desc&search=keyword&filter=all
 */
export async function getDocsPaginatedHandler(req: Request, res: Response) {
  try {
    const userId = (req.user as any)?.id;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const {
      page = '1',
      limit = '20',
      sortField = 'updated_at',
      sortDirection = 'desc',
      search = '',
      filter = 'all'
    } = req.query;

    const options: PaginationOptions = {
      page: Math.max(1, parseInt(page as string, 10) || 1),
      limit: Math.min(100, Math.max(1, parseInt(limit as string, 10) || 20)),
      sortField: sortField as PaginationOptions['sortField'],
      sortDirection: sortDirection as PaginationOptions['sortDirection'],
      search: (search as string).trim()
    };

    console.log("[GetDocsPaginated] Filter:", filter, "Options:", options, "User:", userId);

    let result;
    if (filter === 'my') {
      result = await storage.getDocumentsByOwnerPaginated(userId, options);
    } else if (filter === 'shared') {
      result = await storage.getDocumentsSharedWithUserPaginated(userId, options);
    } else {
      // Default: all documents (owned + shared)
      result = await storage.getAllUserDocumentsPaginated(userId, options);
    }

    console.log("[GetDocsPaginated] Found:", result.total, "total documents, page:", result.page, "of", result.totalPages);

    res.json(result);
  } catch (error) {
    console.error("[GetDocsPaginated] Error:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ message: "Failed to fetch documents", error: errorMessage });
  }
}

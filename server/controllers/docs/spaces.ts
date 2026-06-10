import type { Request, Response } from "express";
import { spaceStorage as storage } from "../../storage/spaceStorage";

/**
 * Get all spaces for the current user as a tree structure
 * GET /api/docs/spaces
 */
export async function getSpacesHandler(req: Request, res: Response) {
  try {
    const userId = (req.user as any)?.id;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const spaces = await storage.getSpaceTree(userId);
    res.json(spaces);
  } catch (error) {
    console.error("[GetSpaces] Error:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ message: "Failed to fetch spaces", error: errorMessage });
  }
}

/**
 * Get a single space by ID
 * GET /api/docs/spaces/:id
 */
export async function getSpaceByIdHandler(req: Request, res: Response) {
  try {
    const userId = (req.user as any)?.id;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const { id } = req.params;
    const space = await storage.getSpaceById(id);

    if (!space) {
      return res.status(404).json({ message: "Space not found" });
    }

    // Check ownership
    if (space.ownerId !== userId) {
      return res.status(403).json({ message: "Not authorized to access this space" });
    }

    res.json(space);
  } catch (error) {
    console.error("[GetSpaceById] Error:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ message: "Failed to fetch space", error: errorMessage });
  }
}

/**
 * Create a new space
 * POST /api/docs/spaces
 */
export async function createSpaceHandler(req: Request, res: Response) {
  try {
    const userId = (req.user as any)?.id;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const { name, description, icon, color, parentSpaceId, isPrivate } = req.body;

    if (!name) {
      return res.status(400).json({ message: "Name is required" });
    }

    // If parentSpaceId is provided, verify it belongs to the user
    if (parentSpaceId) {
      const parentSpace = await storage.getSpaceById(parentSpaceId);
      if (!parentSpace || parentSpace.ownerId !== userId) {
        return res.status(400).json({ message: "Invalid parent space" });
      }
    }

    const space = await storage.createSpace({
      name,
      description,
      icon: icon || "folder",
      color: color || "#3B82F6",
      ownerId: userId,
      parentSpaceId: parentSpaceId || null,
      isPrivate: isPrivate ?? false,
    });

    res.status(201).json(space);
  } catch (error) {
    console.error("[CreateSpace] Error:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ message: "Failed to create space", error: errorMessage });
  }
}

/**
 * Update a space
 * PATCH /api/docs/spaces/:id
 */
export async function updateSpaceHandler(req: Request, res: Response) {
  try {
    const userId = (req.user as any)?.id;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const { id } = req.params;
    const space = await storage.getSpaceById(id);

    if (!space) {
      return res.status(404).json({ message: "Space not found" });
    }

    if (space.ownerId !== userId) {
      return res.status(403).json({ message: "Not authorized to update this space" });
    }

    const { name, description, icon, color, parentSpaceId, sortOrder, isPrivate } = req.body;

    // Prevent circular parent references
    if (parentSpaceId === id) {
      return res.status(400).json({ message: "Space cannot be its own parent" });
    }

    const updated = await storage.updateSpace(id, {
      name,
      description,
      icon,
      color,
      parentSpaceId,
      sortOrder,
      isPrivate,
    });

    res.json(updated);
  } catch (error) {
    console.error("[UpdateSpace] Error:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ message: "Failed to update space", error: errorMessage });
  }
}

/**
 * Delete a space
 * DELETE /api/docs/spaces/:id
 */
export async function deleteSpaceHandler(req: Request, res: Response) {
  try {
    const userId = (req.user as any)?.id;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const { id } = req.params;
    const space = await storage.getSpaceById(id);

    if (!space) {
      return res.status(404).json({ message: "Space not found" });
    }

    if (space.ownerId !== userId) {
      return res.status(403).json({ message: "Not authorized to delete this space" });
    }

    await storage.deleteSpace(id);
    res.status(204).send();
  } catch (error) {
    console.error("[DeleteSpace] Error:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ message: "Failed to delete space", error: errorMessage });
  }
}

/**
 * Get documents in a space
 * GET /api/docs/spaces/:id/documents
 */
export async function getSpaceDocumentsHandler(req: Request, res: Response) {
  try {
    const userId = (req.user as any)?.id;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const { id } = req.params;
    const space = await storage.getSpaceById(id);

    if (!space) {
      return res.status(404).json({ message: "Space not found" });
    }

    if (space.ownerId !== userId) {
      return res.status(403).json({ message: "Not authorized to access this space" });
    }

    const documentIds = await storage.getDocumentsInSpace(id);
    res.json({ documentIds });
  } catch (error) {
    console.error("[GetSpaceDocuments] Error:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ message: "Failed to fetch space documents", error: errorMessage });
  }
}

/**
 * Add a document to a space
 * POST /api/docs/spaces/:id/documents
 */
export async function addDocumentToSpaceHandler(req: Request, res: Response) {
  try {
    const userId = (req.user as any)?.id;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const { id } = req.params;
    const { documentId } = req.body;

    if (!documentId) {
      return res.status(400).json({ message: "documentId is required" });
    }

    const space = await storage.getSpaceById(id);
    if (!space) {
      return res.status(404).json({ message: "Space not found" });
    }

    if (space.ownerId !== userId) {
      return res.status(403).json({ message: "Not authorized to modify this space" });
    }

    // Verify document ownership
    const document = await storage.getDocument(documentId);
    if (!document || document.ownerId !== userId) {
      return res.status(400).json({ message: "Invalid document" });
    }

    const member = await storage.addDocumentToSpace(id, documentId);
    res.status(201).json(member);
  } catch (error) {
    console.error("[AddDocumentToSpace] Error:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ message: "Failed to add document to space", error: errorMessage });
  }
}

/**
 * Remove a document from a space
 * DELETE /api/docs/spaces/:id/documents/:documentId
 */
export async function removeDocumentFromSpaceHandler(req: Request, res: Response) {
  try {
    const userId = (req.user as any)?.id;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const { id, documentId } = req.params;

    const space = await storage.getSpaceById(id);
    if (!space) {
      return res.status(404).json({ message: "Space not found" });
    }

    if (space.ownerId !== userId) {
      return res.status(403).json({ message: "Not authorized to modify this space" });
    }

    await storage.removeDocumentFromSpace(id, documentId);
    res.status(204).send();
  } catch (error) {
    console.error("[RemoveDocumentFromSpace] Error:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ message: "Failed to remove document from space", error: errorMessage });
  }
}

/**
 * Move a document between spaces
 * POST /api/docs/spaces/move-document
 */
export async function moveDocumentHandler(req: Request, res: Response) {
  try {
    const userId = (req.user as any)?.id;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const { documentId, fromSpaceId, toSpaceId } = req.body;

    if (!documentId || !toSpaceId) {
      return res.status(400).json({ message: "documentId and toSpaceId are required" });
    }

    // Verify document ownership
    const document = await storage.getDocument(documentId);
    if (!document || document.ownerId !== userId) {
      return res.status(400).json({ message: "Invalid document" });
    }

    // Verify target space ownership
    const toSpace = await storage.getSpaceById(toSpaceId);
    if (!toSpace || toSpace.ownerId !== userId) {
      return res.status(400).json({ message: "Invalid target space" });
    }

    // Verify source space ownership if provided
    if (fromSpaceId) {
      const fromSpace = await storage.getSpaceById(fromSpaceId);
      if (!fromSpace || fromSpace.ownerId !== userId) {
        return res.status(400).json({ message: "Invalid source space" });
      }
    }

    await storage.moveDocumentToSpace(documentId, fromSpaceId, toSpaceId);
    res.json({ success: true });
  } catch (error) {
    console.error("[MoveDocument] Error:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ message: "Failed to move document", error: errorMessage });
  }
}

/**
 * Get spaces for a document
 * GET /api/docs/:documentId/spaces
 */
export async function getDocumentSpacesHandler(req: Request, res: Response) {
  try {
    const userId = (req.user as any)?.id;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const { documentId } = req.params;

    // Verify document access
    const document = await storage.getDocument(documentId);
    if (!document) {
      return res.status(404).json({ message: "Document not found" });
    }

    // Check if user owns the document or has access
    if (document.ownerId !== userId) {
      const share = await storage.getShareInDocumentTree(documentId, userId);
      if (!share) {
        return res.status(403).json({ message: "Not authorized to access this document" });
      }
    }

    const spaces = await storage.getSpacesForDocument(documentId);
    res.json(spaces);
  } catch (error) {
    console.error("[GetDocumentSpaces] Error:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ message: "Failed to fetch document spaces", error: errorMessage });
  }
}

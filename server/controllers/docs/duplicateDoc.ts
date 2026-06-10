import type { Request, Response } from "express";
import { documentStorage as storage } from "../../storage/documentStorage";

/**
 * Get the base title for duplication by removing existing (Copy) or (Copy) (N) suffixes
 */
function getBaseTitleForDuplication(title: string): string {
  let baseTitle = title.trim();

  // Remove trailing (Copy) (N) pattern like "(Copy) (1)", "(Copy) (2)", etc.
  baseTitle = baseTitle.replace(/\s*\(Copy\)\s*\(\d+\)$/i, '');

  // Remove trailing (Copy) pattern
  baseTitle = baseTitle.replace(/\s*\(Copy\)$/i, '');

  return baseTitle.trim();
}

/**
 * Duplicate a document
 * POST /api/docs/:id/duplicate
 */
export async function duplicateDocHandler(req: Request, res: Response) {
  try {
    const userId = (req.user as any)?.id;
    const originalDoc = await storage.getDocument(req.params.id);

    if (!originalDoc) {
      res.status(404).json({ message: "Document not found" });
      return;
    }

    // Get clean base title (without existing Copy suffixes) and add (Copy)
    const cleanBaseTitle = getBaseTitleForDuplication(originalDoc.title);
    const baseTitle = `${cleanBaseTitle} (Copy)`;
    const uniqueTitle = await storage.generateUniqueDocumentName(baseTitle);

    // Create duplicate document
    const duplicateDoc = await storage.createDocument({
      title: uniqueTitle,
      content: originalDoc.content || "",
      ownerId: userId,
      category: originalDoc.category || 'blank',
      tags: originalDoc.tags || [],
      fontStyle: originalDoc.fontStyle || 'system',
      fontSize: originalDoc.fontSize || 'default',
      pageWidth: originalDoc.pageWidth || 'default',
      backgroundColor: originalDoc.backgroundColor || '#ffffff',
      textColor: originalDoc.textColor || '#1f2937',
      headingColor: originalDoc.headingColor || '#111827',
      h1Color: originalDoc.h1Color || '#111827',
      h2Color: originalDoc.h2Color || '#1f2937',
      h3Color: originalDoc.h3Color || '#374151',
      h4Color: originalDoc.h4Color || '#4b5563',
      h5Color: originalDoc.h5Color || '#6b7280',
      h6Color: originalDoc.h6Color || '#9ca3af',
      linkColor: originalDoc.linkColor || '#3b82f6',
      codeBlockBg: originalDoc.codeBlockBg || '#f3f4f6',
      codeBlockText: originalDoc.codeBlockText || '#1f2937',
      blockquoteBg: originalDoc.blockquoteBg || '#f9fafb',
      blockquoteText: originalDoc.blockquoteText || '#4b5563',
      tableBorderColor: originalDoc.tableBorderColor || '#e5e7eb',
      tableHeaderBg: originalDoc.tableHeaderBg || '#f3f4f6',
      showPageOutline: originalDoc.showPageOutline ?? false,
    });

    console.log("[DuplicateDoc] Document duplicated:", duplicateDoc.id);
    res.status(201).json(duplicateDoc);
  } catch (error) {
    console.error("[DuplicateDoc] Error:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ message: "Failed to duplicate document", error: errorMessage });
  }
}

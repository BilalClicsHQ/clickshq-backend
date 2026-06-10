import type { Request, Response } from "express";
import { documentStorage as storage } from "../../storage/documentStorage";

/**
 * Apply typography styles to all sub-pages of a document
 * POST /api/docs/:id/apply-styles-to-all
 */
export async function applyStylesToAllHandler(req: Request, res: Response) {
  try {
    const userId = (req.user as any)?.id;
    const docId = req.params.id;

    // First, check if document exists
    const doc = await storage.getDocument(docId);
    if (!doc) {
      res.status(404).json({ message: "Document not found" });
      return;
    }

    if (doc.deletedAt) {
      res.status(400).json({ message: "Cannot modify a document that is in trash" });
      return;
    }

    // Check user's permission - only owner can apply styles to all pages
    const isOwner = doc.ownerId === userId;

    // For pages (child documents), also check the root document's owner
    let isRootOwner = false;
    if (doc.parentDocumentId) {
      const rootDoc = await storage.getRootDocument(docId);
      isRootOwner = rootDoc?.ownerId === userId;
    }

    if (!isOwner && !isRootOwner) {
      res.status(403).json({ message: "Only the document owner can apply styles to all pages" });
      return;
    }

    const { fontStyle, fontSize, pageWidth } = req.body;

    // Validate input
    const validFontStyles = ['system', 'serif', 'mono', 'inter', 'roboto', 'playfair'];
    const validFontSizes = ['small', 'default', 'large'];
    const validPageWidths = ['default', 'full'];

    if (fontStyle && !validFontStyles.includes(fontStyle)) {
      res.status(400).json({ message: "Invalid fontStyle value" });
      return;
    }

    if (fontSize && !validFontSizes.includes(fontSize)) {
      res.status(400).json({ message: "Invalid fontSize value" });
      return;
    }

    if (pageWidth && !validPageWidths.includes(pageWidth)) {
      res.status(400).json({ message: "Invalid pageWidth value" });
      return;
    }

    // Build the style updates object
    const styleUpdates: any = {};
    if (fontStyle !== undefined) styleUpdates.fontStyle = fontStyle;
    if (fontSize !== undefined) styleUpdates.fontSize = fontSize;
    if (pageWidth !== undefined) styleUpdates.pageWidth = pageWidth;

    if (Object.keys(styleUpdates).length === 0) {
      res.status(400).json({ message: "No style properties provided" });
      return;
    }

    // Get all child document IDs recursively
    const childIds = await storage.getAllDescendantIds(docId);

    // Update all child documents with the style properties
    let updatedCount = 0;
    for (const childId of childIds) {
      const updated = await storage.updateDocument(childId, styleUpdates, false);
      if (updated) {
        updatedCount++;
      }
    }

    console.log(`[ApplyStylesToAll] Applied styles to ${updatedCount} sub-pages of document ${docId}`);

    res.json({
      success: true,
      updatedCount,
    });
  } catch (error) {
    console.error("Error applying styles to all pages:", error);
    res.status(500).json({ message: "Failed to apply styles to all pages" });
  }
}

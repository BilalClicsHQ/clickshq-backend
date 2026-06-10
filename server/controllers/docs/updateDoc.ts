import type { Request, Response } from "express";
import { documentStorage as storage } from "../../storage/documentStorage";
import { maybeCreateAutoVersion } from "./versionHelper";

/**
 * Update a document
 * PUT /api/docs/:id
 */
export async function updateDocHandler(req: Request, res: Response) {
  try {
    const userId = (req.user as any)?.id;
    const docId = req.params.id;

    // First, check if user has permission to edit this document
    const doc = await storage.getDocument(docId);
    if (!doc) {
      res.status(404).json({ message: "Document not found" });
      return;
    }

    if (doc.deletedAt) {
      res.status(400).json({ message: "Cannot edit a document that is in trash" });
      return;
    }

    // Check user's permission
    let canEdit = false;
    const isOwner = doc.ownerId === userId;
    if (isOwner) {
      // Owner can always edit
      canEdit = true;
    } else {
      // If document is protected, only the owner can edit
      if (doc.isProtected) {
        res.status(403).json({ message: "This document is protected. Only the owner can edit it." });
        return;
      }

      // Check if user has edit or edit_comment permission anywhere in the document tree
      // For pages (child documents), also check the root document's owner
      if (doc.parentDocumentId) {
        const rootDoc = await storage.getRootDocument(docId);
        if (rootDoc && rootDoc.ownerId === userId) {
          canEdit = true;
        }
      }
      if (!canEdit) {
        const share = await storage.getShareInDocumentTree(docId, userId);
        if (share && (share.permission === "edit" || share.permission === "edit_comment")) {
          canEdit = true;
        }
      }
    }

    if (!canEdit) {
      res.status(403).json({ message: "You don't have permission to edit this document" });
      return;
    }

    const {
      title,
      content,
      tags,
      fontStyle,
      fontSize,
      pageWidth,
      backgroundColor,
      textColor,
      headingColor,
      h1Color,
      h2Color,
      h3Color,
      h4Color,
      h5Color,
      h6Color,
      linkColor,
      codeBlockBg,
      codeBlockText,
      blockquoteBg,
      blockquoteText,
      tableBorderColor,
      tableHeaderBg,
      showPageOutline
    } = req.body;

    // Only the owner can rename (change title) of documents/pages
    if (title !== undefined && !isOwner) {
      // For pages, also check if user is the root document owner
      let isRootOwner = false;
      if (doc.parentDocumentId) {
        const rootDoc = await storage.getRootDocument(docId);
        isRootOwner = rootDoc?.ownerId === userId;
      }
      if (!isRootOwner) {
        return res.status(403).json({ message: "Only the document owner can rename this document" });
      }
    }

    const updates: any = {};
    if (title !== undefined) updates.title = title;
    if (content !== undefined) updates.content = content;
    if (tags !== undefined) updates.tags = tags;
    if (fontStyle !== undefined) updates.fontStyle = fontStyle;
    if (fontSize !== undefined) updates.fontSize = fontSize;
    if (pageWidth !== undefined) updates.pageWidth = pageWidth;
    if (backgroundColor !== undefined) updates.backgroundColor = backgroundColor;
    if (textColor !== undefined) updates.textColor = textColor;
    if (headingColor !== undefined) updates.headingColor = headingColor;
    if (h1Color !== undefined) updates.h1Color = h1Color;
    if (h2Color !== undefined) updates.h2Color = h2Color;
    if (h3Color !== undefined) updates.h3Color = h3Color;
    if (h4Color !== undefined) updates.h4Color = h4Color;
    if (h5Color !== undefined) updates.h5Color = h5Color;
    if (h6Color !== undefined) updates.h6Color = h6Color;
    if (linkColor !== undefined) updates.linkColor = linkColor;
    if (codeBlockBg !== undefined) updates.codeBlockBg = codeBlockBg;
    if (codeBlockText !== undefined) updates.codeBlockText = codeBlockText;
    if (blockquoteBg !== undefined) updates.blockquoteBg = blockquoteBg;
    if (blockquoteText !== undefined) updates.blockquoteText = blockquoteText;
    if (tableBorderColor !== undefined) updates.tableBorderColor = tableBorderColor;
    if (tableHeaderBg !== undefined) updates.tableHeaderBg = tableHeaderBg;
    if (showPageOutline !== undefined) updates.showPageOutline = showPageOutline;

    // Handle isFavorite
    const { isFavorite } = req.body;
    if (isFavorite !== undefined) updates.isFavorite = isFavorite;

    // Only update timestamp and lastUpdatedBy if title or content changed
    const shouldUpdateTimestamp = title !== undefined || content !== undefined;
    if (shouldUpdateTimestamp && userId) {
      updates.lastUpdatedBy = userId;
    }

    // Auto-version: fire-and-forget so it never blocks the save
    if (content !== undefined && doc) {
      maybeCreateAutoVersion(doc, userId).catch(() => {});
    }

    const updatedDoc = await storage.updateDocument(req.params.id, updates, shouldUpdateTimestamp);

    if (!updatedDoc) {
      res.status(404).json({ message: "Document not found" });
      return;
    }

    res.json(updatedDoc);
  } catch (error) {
    console.error("Error updating document:", error);
    res.status(500).json({ message: "Failed to update document" });
  }
}

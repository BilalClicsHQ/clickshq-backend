import type { Request, Response } from "express";
import {
  type MulterFile,
  validateFile,
  isMulterError,
} from "./docImportUtils";

// POST /api/docs/validate
export async function validateFileHandler(req: Request & { file?: MulterFile }, res: Response) {
  try {
    if (!req.file) {
      return res.status(400).json({
        isValid: false,
        error: "No file uploaded"
      });
    }

    const validation = await validateFile(req.file);

    if (!validation.isValid) {
      return res.status(400).json({
        isValid: false,
        fileName: validation.fileName,
        fileSize: validation.fileSize,
        fileType: validation.fileType,
        error: validation.error
      });
    }

    // File is valid
    return res.status(200).json({
      isValid: true,
      fileName: validation.fileName,
      fileSize: validation.fileSize,
      fileType: validation.fileType,
      message: "File is valid and ready to import"
    });

  } catch (error: unknown) {
    console.error("[DocValidate] Error:", error);

    if (isMulterError(error)) {
      if (error.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({
          isValid: false,
          error: "File size exceeds 10MB limit"
        });
      }
      return res.status(400).json({
        isValid: false,
        error: error.message
      });
    }

    res.status(500).json({
      isValid: false,
      error: "Failed to validate file"
    });
  }
}

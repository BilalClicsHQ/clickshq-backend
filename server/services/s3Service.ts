import { S3Client, PutObjectCommand, CopyObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import crypto from "crypto";

const s3Client = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  },
});

export interface S3UploadResult {
  key: string;
  bucket: string;
  region: string;
  publicUrl: string;
}

/**
 * Uploads a file buffer to AWS S3.
 * Returns the object details including direct public S3 URL.
 */
export async function uploadFileToS3(
  file: Express.Multer.File,
  taskId: string
): Promise<S3UploadResult> {
  const bucketName = process.env.AWS_S3_BUCKET;
  if (!bucketName) {
    // Local/dev fallback: no S3 configured → store the file inline as a base64
    // data URL so uploads still work without AWS credentials. Capped at 10 MB to
    // avoid bloating the DB; configure AWS_S3_BUCKET for larger/production files.
    const MAX_INLINE_BYTES = 10 * 1024 * 1024;
    if (file.size > MAX_INLINE_BYTES) {
      throw new Error(
        "File is too large for local storage (max 10 MB). Configure AWS_S3_BUCKET to upload larger files."
      );
    }
    const uuid = crypto.randomUUID();
    const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, "_");
    const dataUrl = `data:${file.mimetype};base64,${file.buffer.toString("base64")}`;
    return {
      key: `local/tasks/${taskId}/${uuid}-${sanitizedName}`,
      bucket: "local",
      region: "local",
      publicUrl: dataUrl,
    };
  }

  const region = process.env.AWS_REGION || "us-east-1";
  const uuid = crypto.randomUUID();
  // Sanitize filename to replace spaces and special characters with underscores
  const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, "_");
  const key = `tasks/${taskId}/${uuid}-${sanitizedName}`;

  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
    })
  );

  // Direct S3 URL structure: https://<bucketName>.s3.<region>.amazonaws.com/<key>
  const publicUrl = `https://${bucketName}.s3.${region}.amazonaws.com/${key}`;

  return {
    key,
    bucket: bucketName,
    region,
    publicUrl,
  };
}

/**
 * Copies an object in S3.
 */
export async function copyS3Object(srcKey: string, destKey: string): Promise<void> {
  const bucketName = process.env.AWS_S3_BUCKET;
  if (!bucketName) {
    throw new Error("AWS_S3_BUCKET environment variable is not defined");
  }
  await s3Client.send(
    new CopyObjectCommand({
      Bucket: bucketName,
      CopySource: `${bucketName}/${srcKey}`,
      Key: destKey,
    })
  );
}

/**
 * Deletes an object in S3.
 */
export async function deleteS3Object(key: string): Promise<void> {
  const bucketName = process.env.AWS_S3_BUCKET;
  if (!bucketName) {
    throw new Error("AWS_S3_BUCKET environment variable is not defined");
  }
  await s3Client.send(
    new DeleteObjectCommand({
      Bucket: bucketName,
      Key: key,
    })
  );
}


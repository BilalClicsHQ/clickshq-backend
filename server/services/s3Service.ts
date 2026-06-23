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
    throw new Error("AWS_S3_BUCKET environment variable is not defined");
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


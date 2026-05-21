/**
 * Storage utilities for Mike document management.
 *
 * Two backends:
 *   1. Cloudflare R2 (S3-compatible) — production. Requires R2_* env vars.
 *   2. Local filesystem — dev/demo. Set MIKE_LOCAL_STORAGE_DIR to enable.
 *      Files are written under that directory keyed by the storage key.
 *
 * R2 env vars:
 *   R2_ENDPOINT_URL      — https://<account-id>.r2.cloudflarestorage.com
 *   R2_ACCESS_KEY_ID     — R2 API token (Access Key ID)
 *   R2_SECRET_ACCESS_KEY — R2 API token (Secret Access Key)
 *   R2_BUCKET_NAME       — bucket name (default: "mike")
 *
 * Local FS env var:
 *   MIKE_LOCAL_STORAGE_DIR — absolute path to a directory Mike can write to.
 *
 * If MIKE_LOCAL_STORAGE_DIR is set it takes precedence over R2 — even if
 * both sets are configured — so local dev never accidentally writes to R2.
 */

import { promises as fsp, mkdirSync } from "fs";
import { dirname, join, resolve } from "path";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl as awsGetSignedUrl } from "@aws-sdk/s3-request-presigner";
import { buildDownloadUrl as buildSignedDownloadUrl } from "./downloadTokens";

// ---------------------------------------------------------------------------
// Backend selection
// ---------------------------------------------------------------------------

function localStorageRoot(): string | null {
  const raw = process.env.MIKE_LOCAL_STORAGE_DIR?.trim();
  return raw ? resolve(raw) : null;
}

const r2Configured = Boolean(
  process.env.R2_ENDPOINT_URL &&
  process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_SECRET_ACCESS_KEY,
);

function getClient(): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT_URL!,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  });
}

const BUCKET = process.env.R2_BUCKET_NAME ?? "mike";

export const storageEnabled = Boolean(localStorageRoot()) || r2Configured;

function resolveLocalPath(key: string): string {
  const root = localStorageRoot();
  if (!root) {
    throw new Error("MIKE_LOCAL_STORAGE_DIR is not set");
  }
  // Defence against path traversal — keys are constructed server-side by
  // storageKey() etc., but enforce anyway.
  if (key.includes("..")) {
    throw new Error(`Invalid storage key: ${key}`);
  }
  const target = resolve(join(root, key));
  if (!target.startsWith(root)) {
    throw new Error(`Storage key escapes root: ${key}`);
  }
  return target;
}

// Create the local storage root eagerly so first writes don't race.
{
  const root = localStorageRoot();
  if (root) {
    try {
      mkdirSync(root, { recursive: true });
    } catch (err) {
      console.warn("[storage] failed to create local storage root", root, err);
    }
  }
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

export async function uploadFile(
  key: string,
  content: ArrayBuffer,
  contentType: string,
): Promise<void> {
  if (localStorageRoot()) {
    const target = resolveLocalPath(key);
    await fsp.mkdir(dirname(target), { recursive: true });
    await fsp.writeFile(target, Buffer.from(content));
    if (contentType) {
      try {
        await fsp.writeFile(target + ".meta", contentType, "utf8");
      } catch {
        /* metadata is best-effort */
      }
    }
    return;
  }
  const client = getClient();
  await client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: Buffer.from(content),
      ContentType: contentType,
    }),
  );
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

export async function downloadFile(key: string): Promise<ArrayBuffer | null> {
  if (!storageEnabled) return null;
  if (localStorageRoot()) {
    try {
      const buf = await fsp.readFile(resolveLocalPath(key));
      // Buffer is a Uint8Array view of an ArrayBuffer; return a tight copy
      // so callers see only the file bytes.
      const ab = buf.buffer.slice(
        buf.byteOffset,
        buf.byteOffset + buf.byteLength,
      );
      return ab as ArrayBuffer;
    } catch {
      return null;
    }
  }
  try {
    const client = getClient();
    const response = await client.send(
      new GetObjectCommand({ Bucket: BUCKET, Key: key }),
    );
    if (!response.Body) return null;
    const bytes = await response.Body.transformToByteArray();
    return bytes.buffer as ArrayBuffer;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export async function deleteFile(key: string): Promise<void> {
  if (!storageEnabled) return;
  if (localStorageRoot()) {
    try {
      await fsp.unlink(resolveLocalPath(key));
    } catch {
      /* idempotent */
    }
    try {
      await fsp.unlink(resolveLocalPath(key) + ".meta");
    } catch {
      /* idempotent */
    }
    return;
  }
  const client = getClient();
  await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

// ---------------------------------------------------------------------------
// Signed URL (pre-signed for temporary direct access)
// ---------------------------------------------------------------------------

export async function getSignedUrl(
  key: string,
  expiresIn = 3600,
  downloadFilename?: string,
): Promise<string | null> {
  if (!storageEnabled) return null;
  if (localStorageRoot()) {
    // In local-FS mode we don't have a third-party signing surface, so we
    // route through Mike's existing /download/:token route (HMAC-signed,
    // streamed via downloadFile()). The signed URL is non-expiring, which
    // is fine for local dev — the frontend behaviour is the same.
    void expiresIn;
    const filename = downloadFilename || key.split("/").pop() || "download";
    return buildSignedDownloadUrl(key, filename);
  }
  try {
    const client = getClient();
    // Override the response Content-Disposition so the browser uses this
    // filename on download, instead of the last path segment of the R2 key
    // (which includes the document UUID). The `download` attribute on <a>
    // is ignored for cross-origin URLs, so we have to set it server-side.
    const responseContentDisposition = downloadFilename
      ? buildContentDisposition("attachment", downloadFilename)
      : undefined;
    const command = new GetObjectCommand({
      Bucket: BUCKET,
      Key: key,
      ResponseContentDisposition: responseContentDisposition,
    });
    return await awsGetSignedUrl(client, command, { expiresIn });
  } catch {
    return null;
  }
}

export function normalizeDownloadFilename(name: string): string {
  const trimmed = name.trim();
  const base = trimmed || "download";
  return base.replace(/[\x00-\x1F\x7F]/g, "_").replace(/[\\/]/g, "_");
}

export function sanitizeDispositionFilename(name: string): string {
  return normalizeDownloadFilename(name).replace(/["\\]/g, "_");
}

export function encodeRFC5987(str: string): string {
  return encodeURIComponent(str).replace(
    /['()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

export function buildContentDisposition(
  kind: "inline" | "attachment",
  filename: string,
): string {
  const normalized = normalizeDownloadFilename(filename);
  return `${kind}; filename="${sanitizeDispositionFilename(normalized)}"; filename*=UTF-8''${encodeRFC5987(normalized)}`;
}

// ---------------------------------------------------------------------------
// Storage key helpers
// ---------------------------------------------------------------------------

export function storageKey(
  userId: string,
  docId: string,
  filename: string,
): string {
  return `documents/${userId}/${docId}/source${storageExtension(filename, ".bin")}`;
}

export function pdfStorageKey(
  userId: string,
  docId: string,
  stem: string,
): string {
  return `documents/${userId}/${docId}/${stem}.pdf`;
}

export function generatedDocKey(
  userId: string,
  docId: string,
  filename: string,
): string {
  return `generated/${userId}/${docId}/generated${storageExtension(filename, ".docx")}`;
}

export function versionStorageKey(
  userId: string,
  docId: string,
  versionSlug: string,
  filename: string,
): string {
  return `documents/${userId}/${docId}/versions/${versionSlug}${storageExtension(filename, ".bin")}`;
}

function storageExtension(filename: string, fallback: string): string {
  const lastDot = filename.lastIndexOf(".");
  if (lastDot < 0) return fallback;
  const ext = filename.slice(lastDot).toLowerCase();
  return /^\.[a-z0-9]{1,16}$/.test(ext) ? ext : fallback;
}

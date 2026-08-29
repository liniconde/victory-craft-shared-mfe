import { MULTIPART_UPLOAD_THRESHOLD_BYTES, uploadFileMultipart, type HttpClient } from "./multipartUpload";

export type { HttpClient } from "./multipartUpload";

export interface UploadVideoFileOptions {
  /** The host app's own axios instance (already configured with
   * baseURL/auth) — used only for the control calls (`POST /videos/upload`,
   * and the multipart init/part-urls/complete/abort calls for large files).
   * The actual bytes always go straight to S3 via a raw PUT, never through
   * this client, so an app's Authorization header never reaches S3. */
  httpClient: HttpClient;
  /** S3 object key to upload to — the caller decides the naming scheme
   * (each host app already has its own convention, e.g. `videos/library/
   * ${Date.now()}-${safeName}`). */
  objectKey: string;
  /** File extension without the dot, e.g. "mp4". Defaults to the extension
   * of `file.name`. */
  fileType?: string;
  durationSeconds?: number;
  onUploadProgress?: (progress: number) => void;
}

export interface UploadVideoFileResult {
  /** The S3 object key the file was ultimately stored under (the backend
   * may have adjusted it, e.g. multipart's `complete` response). */
  s3Key: string;
  /** Public/playable URL for the uploaded file, when the backend returned one. */
  videoUrl?: string;
  s3Url?: string;
}

const pickString = (data: Record<string, unknown>, keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
};

/** Raw XHR PUT with upload progress — deliberately not routed through the
 * host app's httpClient: presigned S3 URLs already carry their own
 * authorization (the signature) and must not receive the app's own
 * Authorization header. */
const putFileToUrl = (url: string, file: File, onUploadProgress?: (progress: number) => void): Promise<void> =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.upload.onprogress = (event) => {
      if (!onUploadProgress || !event.lengthComputable) return;
      const progress = Math.round((event.loaded / event.total) * 100);
      onUploadProgress(Math.min(99, Math.max(0, progress)));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error(`Error uploading file to S3: HTTP ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error("Network error uploading file to S3."));
    xhr.send(file);
  });

/**
 * Uploads a local video File end-to-end: requests a presigned target from
 * the host app's own backend (`POST /videos/upload`, same contract already
 * used by both videos-mfe and root — `{ objectKey, fileType }` in, an
 * upload URL / final key / public URL out, with a few historical field-name
 * fallbacks on the response), then routes to a single PUT or S3 multipart
 * upload depending on file size.
 */
export const uploadVideoFile = async (file: File, options: UploadVideoFileOptions): Promise<UploadVideoFileResult> => {
  const fileType = options.fileType ?? (file.name.split(".").pop() || "mp4");

  if (file.size >= MULTIPART_UPLOAD_THRESHOLD_BYTES) {
    const { s3Url, objectKey } = await uploadFileMultipart({
      httpClient: options.httpClient,
      file,
      objectKey: options.objectKey,
      fileType,
      fileSizeBytes: file.size,
      durationSeconds: options.durationSeconds,
      onUploadProgress: options.onUploadProgress,
    });
    return { s3Key: objectKey, videoUrl: s3Url, s3Url };
  }

  const response = await options.httpClient.post<Record<string, unknown>>("/videos/upload", {
    objectKey: options.objectKey,
    fileType,
  });
  const data = response.data ?? {};

  const uploadUrl = pickString(data, ["uploadUrl", "url", "presignedUrl", "signedUrl"]);
  const s3Key = pickString(data, ["objectKey", "key"]) ?? options.objectKey;
  const videoUrl = pickString(data, ["fileUrl", "s3Url", "publicUrl", "url"]);

  if (!uploadUrl) {
    throw new Error("The backend did not return a valid upload URL.");
  }

  await putFileToUrl(uploadUrl, file, options.onUploadProgress);
  options.onUploadProgress?.(100);

  return { s3Key, videoUrl, s3Url: videoUrl };
};

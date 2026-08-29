/** Files at or above this size use S3 multipart upload instead of a single PUT. */
export const MULTIPART_UPLOAD_THRESHOLD_BYTES = 150 * 1024 * 1024;

const MAX_PART_CONCURRENCY = 4;
const MAX_PART_RETRIES = 3;
const RETRY_BACKOFF_BASE_MS = 200;

/** No `xhr.upload.onprogress` (nor `onload`/`onerror`) for this long means the
 * connection stalled at the TCP level — real large uploads over degraded
 * networks do this without S3 ever closing the socket, and a plain XHR has
 * no built-in stall detection (only a total-duration `xhr.timeout`, which
 * would misfire on legitimately slow-but-progressing parts). Without this,
 * the part's promise never settles and the whole upload hangs forever. */
const DEFAULT_PART_STALL_TIMEOUT_MS = 20_000;
/** Control calls (init/part-urls/complete/abort) are tiny JSON payloads —
 * if one hangs (e.g. the final `complete` call after all parts already hit
 * 99%), there's no reason to wait long before surfacing an error instead of
 * leaving the UI stuck. */
const CONTROL_CALL_TIMEOUT_MS = 30_000;

/**
 * Minimal HTTP client shape this module needs for its control calls (init /
 * part-urls / complete / abort) — matches axios's `post` call signature
 * exactly, so passing a real axios instance (each host app's own, already
 * configured with baseURL/auth) satisfies this with zero adapter code. The
 * actual bytes for each part are always sent via a raw XHR PUT straight to
 * S3 (see `putPartWithProgress` below), never through this client — an S3
 * presigned URL must not carry the host app's Authorization header.
 */
export interface HttpClient {
  post<T = unknown>(url: string, data?: unknown, config?: { timeout?: number }): Promise<{ data: T }>;
}

export interface MultipartInitResponse {
  uploadId: string;
  key: string;
  objectKey: string;
  partSizeBytes: number;
  partCount: number;
}

export interface MultipartPartUrl {
  partNumber: number;
  url: string;
}

export interface MultipartUploadedPart {
  partNumber: number;
  eTag: string;
}

export interface MultipartUploadParams {
  httpClient: HttpClient;
  file: Blob;
  objectKey: string;
  fileType: string;
  fileSizeBytes: number;
  durationSeconds?: number;
  roomId?: string;
  matchSessionId?: string;
  onUploadProgress?: (progress: number) => void;
  /** Overrides `DEFAULT_PART_STALL_TIMEOUT_MS`. Exposed mainly so tests can
   * exercise the stall path without waiting 20s of real time. */
  partStallTimeoutMs?: number;
}

export interface MultipartUploadResult {
  s3Url: string;
  objectKey: string;
}

const putPartWithProgress = (
  url: string,
  blob: Blob,
  onProgress?: (loadedBytes: number) => void,
  stallTimeoutMs: number = DEFAULT_PART_STALL_TIMEOUT_MS,
): Promise<string> => {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);

    let settled = false;
    let lastActivityAt = Date.now();
    const pollIntervalMs = Math.max(50, Math.min(1000, stallTimeoutMs / 4));
    const stallCheckId = setInterval(() => {
      if (Date.now() - lastActivityAt >= stallTimeoutMs) {
        settle(() => {
          xhr.abort();
          reject(new Error("The upload for this part stalled (no network progress)."));
        });
      }
    }, pollIntervalMs);

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearInterval(stallCheckId);
      fn();
    };

    xhr.upload.onprogress = (event) => {
      lastActivityAt = Date.now();
      if (!event.lengthComputable || !onProgress) return;
      onProgress(event.loaded);
    };
    xhr.onload = () => {
      settle(() => {
        if (xhr.status >= 200 && xhr.status < 300) {
          const eTag = xhr.getResponseHeader("ETag");
          if (!eTag) {
            // Requires the S3 bucket CORS config to include `ExposeHeaders: ["ETag"]`,
            // otherwise the browser can read the upload response but not this header.
            reject(
              new Error("S3 did not return the ETag header for the uploaded part (check bucket CORS ExposeHeaders)."),
            );
            return;
          }
          resolve(eTag);
        } else {
          reject(new Error(`Error uploading part to S3: HTTP ${xhr.status}`));
        }
      });
    };
    xhr.onerror = () => settle(() => reject(new Error("Network error uploading part to S3.")));
    xhr.send(blob);
  });
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const withRetries = async <T,>(fn: () => Promise<T>, retries: number): Promise<T> => {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < retries) await wait(RETRY_BACKOFF_BASE_MS * 2 ** attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

export const uploadFileMultipart = async (params: MultipartUploadParams): Promise<MultipartUploadResult> => {
  const { httpClient } = params;

  const initResponse = await httpClient.post<MultipartInitResponse>(
    "/videos/upload/multipart/init",
    {
      objectKey: params.objectKey,
      fileType: params.fileType,
      fileSizeBytes: params.fileSizeBytes,
      durationSeconds: params.durationSeconds,
      roomId: params.roomId,
      matchSessionId: params.matchSessionId,
    },
    { timeout: CONTROL_CALL_TIMEOUT_MS },
  );

  const { uploadId, key, partSizeBytes, partCount } = initResponse.data;
  const partNumbers = Array.from({ length: partCount }, (_, index) => index + 1);

  const urlsResponse = await httpClient.post<{ parts: MultipartPartUrl[] }>(
    "/videos/upload/multipart/part-urls",
    { key, uploadId, partNumbers },
    { timeout: CONTROL_CALL_TIMEOUT_MS },
  );
  const urlByPartNumber = new Map(urlsResponse.data.parts.map((part) => [part.partNumber, part.url]));

  const uploadedParts: MultipartUploadedPart[] = new Array(partCount);
  const loadedBytesByPart = new Array(partCount).fill(0);

  const reportProgress = () => {
    if (!params.onUploadProgress) return;
    const loaded = loadedBytesByPart.reduce((sum, value) => sum + value, 0);
    const progress = Math.round((loaded / params.fileSizeBytes) * 100);
    params.onUploadProgress(Math.min(99, Math.max(0, progress)));
  };

  const uploadPart = async (partNumber: number) => {
    const url = urlByPartNumber.get(partNumber);
    if (!url) throw new Error(`No signed URL received for part ${partNumber}.`);

    const start = (partNumber - 1) * partSizeBytes;
    const end = Math.min(start + partSizeBytes, params.fileSizeBytes);
    const partBlob = params.file.slice(start, end);

    const eTag = await withRetries(
      () =>
        putPartWithProgress(
          url,
          partBlob,
          (loadedBytes) => {
            loadedBytesByPart[partNumber - 1] = loadedBytes;
            reportProgress();
          },
          params.partStallTimeoutMs,
        ),
      MAX_PART_RETRIES,
    );

    loadedBytesByPart[partNumber - 1] = partBlob.size;
    reportProgress();
    uploadedParts[partNumber - 1] = { partNumber, eTag };
  };

  const queue = [...partNumbers];
  const runWorker = async () => {
    while (queue.length > 0) {
      const partNumber = queue.shift();
      if (partNumber === undefined) return;
      await uploadPart(partNumber);
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(MAX_PART_CONCURRENCY, partCount) }, runWorker));
  } catch (error) {
    await httpClient
      .post("/videos/upload/multipart/abort", { key, uploadId }, { timeout: CONTROL_CALL_TIMEOUT_MS })
      .catch(() => undefined);
    throw error;
  }

  const completeResponse = await httpClient.post<{ s3Url: string; objectKey: string }>(
    "/videos/upload/multipart/complete",
    { key, uploadId, parts: uploadedParts },
    { timeout: CONTROL_CALL_TIMEOUT_MS },
  );

  params.onUploadProgress?.(100);

  return {
    s3Url: completeResponse.data.s3Url,
    objectKey: completeResponse.data.objectKey ?? key,
  };
};

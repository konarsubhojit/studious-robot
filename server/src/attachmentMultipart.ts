import crypto from 'node:crypto';
import { createAttachmentKey, presignObjectRequest, presignAttachmentUpload, MAX_PRESIGN_TTL_SECONDS } from './attachments.ts';
import type { R2Config } from './attachments.ts';

export const ATTACHMENT_PART_BYTES = 5 * 1024 * 1024;
const PRIVATE_CACHE_CONTROL = 'private, max-age=31536000, immutable';

/** Stable through restarts/credential rotation. Only the server chooses actor. */
export function queuedAttachmentKey(scope: string, actor: string, clientId: string, mimeType: string, sizeBytes: number): string {
  if (/[/\\\u0000-\u001f\u007f]/.test(scope)) throw new Error('Invalid attachment scope');
  const template = createAttachmentKey({ conversationId: scope, mimeType });
  const identity = crypto.createHash('sha256')
    .update(JSON.stringify([scope, actor, clientId, mimeType, sizeBytes])).digest('hex');
  return template.replace(/[^/]+(\.[^.]+)$/, `${identity}$1`);
}

function xmlDecode(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function xmlValue(xml: string, tag: string): string {
  return xmlDecode(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml)?.[1] ?? '');
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export type StoredPart = { partNumber: number; etag: string; sizeBytes: number };
export type UploadOperationResult = {
  key?: string; reference?: string; completed?: boolean; aborted?: boolean;
  cleanupAfter?: number; cleanupComplete?: boolean; retryAfterMs?: number;
  uploadId?: string; partSize?: number; parts?: StoredPart[];
  uploadUrl?: string; expiresAt?: string; headers?: Record<string, string>;
};

/** Control-plane only: binaries go directly to R2 with size-bound presigns. */
export async function attachmentUploadOperation({
  config, key, mimeType, sizeBytes, action, uploadId, partNumber, fetchImpl = fetch,
}: {
  config: R2Config; key: string; mimeType: string; sizeBytes: number;
  action: string; uploadId?: string; partNumber?: number; fetchImpl?: typeof fetch;
}): Promise<UploadOperationResult> {
  const request = async (method: string, queryValues: Record<string, string> = {}, body?: string, headers: Record<string, string> = {}, objectKey = key) => {
    const signed = presignObjectRequest({ config, method, key: objectKey, queryValues, signedHeaderValues: headers });
    return fetchImpl(signed.url, { method, headers, signal: AbortSignal.timeout(30_000), ...(body === undefined ? {} : { body }) });
  };
  const requireOk = async (response: Response) => {
    if (!response.ok) throw new Error(`R2 control request failed (${response.status})`);
    return response.text();
  };
  const uploads = async (): Promise<string[]> => {
    const ids: string[] = [];
    let markers: Record<string, string> = {};
    for (;;) {
      const xml = await requireOk(await request('GET', { uploads: '', prefix: key, ...markers }, undefined, {}, ''));
      for (const match of xml.matchAll(/<Upload>([\s\S]*?)<\/Upload>/g)) {
        if (xmlValue(match[1], 'Key') === key) ids.push(xmlValue(match[1], 'UploadId'));
      }
      if (xmlValue(xml, 'IsTruncated') !== 'true') return ids;
      markers = { 'key-marker': xmlValue(xml, 'NextKeyMarker'), 'upload-id-marker': xmlValue(xml, 'NextUploadIdMarker') };
      if (!markers['key-marker']) throw new Error('Invalid R2 upload pagination');
    }
  };
  const parts = async (id: string): Promise<StoredPart[]> => {
    const xml = await requireOk(await request('GET', { uploadId: id }));
    if (xmlValue(xml, 'IsTruncated') === 'true') throw new Error('Too many attachment parts');
    return [...xml.matchAll(/<Part>([\s\S]*?)<\/Part>/g)].map(match => ({
      partNumber: Number(xmlValue(match[1], 'PartNumber')),
      etag: xmlValue(match[1], 'ETag'),
      sizeBytes: Number(xmlValue(match[1], 'Size')),
    })).sort((a, b) => a.partNumber - b.partNumber);
  };
  const isDiscarded = async () => {
    const response = await request('HEAD', {}, undefined, {}, `${key}.discarded`);
    if (response.ok) return true;
    if (response.status !== 404) await requireOk(response);
    return false;
  };
  const abortIncomplete = async () => {
    const ids = new Set(await uploads());
    // In-flight parts can finish during abort. A known checkpoint ID must be
    // re-aborted by the final sweep even after it disappears from ListUploads.
    // S3/R2 binds UploadId to this exact (server-computed) object key.
    if (uploadId) ids.add(uploadId);
    for (const id of ids) {
      const response = await request('DELETE', { uploadId: id });
      if (response.status !== 404) await requireOk(response);
    }
  };
  const clean = async () => {
    await abortIncomplete();
    const response = await request('DELETE');
    if (response.status !== 404) await requireOk(response);
  };
  const isCompleted = async () => {
    const head = await request('HEAD');
    if (head.ok) {
      if (Number(head.headers.get('content-length')) !== sizeBytes) throw new Error('Stored attachment size mismatch');
      return true;
    }
    if (head.status !== 404) await requireOk(head);
    return false;
  };
  const fence = async () => {
    if (await isDiscarded()) {
      await clean();
      throw new Error('Attachment was discarded');
    }
  };

  const abort = async () => {
    // List by deterministic identity even if initiation succeeded before the
    // client could checkpoint its uploadId. Aborting removes all stored parts.
    // A durable storage fence closes cross-process/restart races: a late
    // initiation/completion must clean itself rather than resurrecting bytes.
    const markerKey = `${key}.discarded`;
    const marker = await request('HEAD', {}, undefined, {}, markerKey);
    if (!marker.ok && marker.status !== 404) await requireOk(marker);
    let cleanupAfter = Number(marker.headers.get('x-amz-meta-cleanup-after'));
    if (!marker.ok || !Number.isFinite(cleanupAfter) || cleanupAfter <= 0) {
      // The maximum grant lifetime also covers a TTL configuration change.
      cleanupAfter = Date.now() + MAX_PRESIGN_TTL_SECONDS * 1000 + 120_000;
      await requireOk(await request('PUT', {}, '', {
        'content-length': '0', 'x-amz-meta-cleanup-after': String(cleanupAfter),
      }, markerKey));
    }
    await clean();
    const retryAfterMs = Math.max(0, cleanupAfter - Date.now());
    return { key, aborted: true, cleanupAfter, retryAfterMs, cleanupComplete: retryAfterMs === 0 };
  };
  const prepare = async () => {
    if (await isCompleted()) {
      await abortIncomplete();
      return { key, reference: key, completed: true };
    }
    if (sizeBytes <= ATTACHMENT_PART_BYTES) {
      const signed = presignAttachmentUpload({ config, key, mimeType, sizeBytes, cacheControl: PRIVATE_CACHE_CONTROL });
      await fence();
      return { ...signed, completed: false };
    }
    let id = (await uploads())[0];
    if (!id) {
      const xml = await requireOk(await request('POST', { uploads: '' }, undefined, {
        'content-type': mimeType, 'cache-control': PRIVATE_CACHE_CONTROL,
      }));
      id = xmlValue(xml, 'UploadId');
      if (!id) throw new Error('R2 did not return an upload id');
    }
    await fence();
    // A delayed initiation can overlap another worker's completion (e.g. a
    // restart after a lost response). Retire that session instead of leaking
    // duplicate parts or re-uploading an already completed object.
    if (await isCompleted()) {
      await abortIncomplete();
      return { key, reference: key, completed: true };
    }
    return { key, reference: key, uploadId: id, partSize: ATTACHMENT_PART_BYTES, parts: await parts(id), completed: false };
  };
  const count = Math.ceil(sizeBytes / ATTACHMENT_PART_BYTES);
  const signPart = (id: string) => {
    if (!Number.isInteger(partNumber) || partNumber! < 1 || partNumber! > count) throw new Error('Invalid part number');
    const bytes = Math.min(ATTACHMENT_PART_BYTES, sizeBytes - (partNumber! - 1) * ATTACHMENT_PART_BYTES);
    const headers = { 'Content-Length': String(bytes) };
    const signed = presignObjectRequest({
      config, method: 'PUT', key, queryValues: { uploadId: id, partNumber: String(partNumber) },
      signedHeaderValues: { 'content-length': String(bytes) },
    });
    return { uploadUrl: signed.url, expiresAt: signed.expiresAt, headers };
  };
  const complete = async (id: string) => {
    const completed = await parts(id);
    if (completed.length !== count || completed.some((part, i) =>
      part.partNumber !== i + 1 || !part.etag ||
      part.sizeBytes !== Math.min(ATTACHMENT_PART_BYTES, sizeBytes - i * ATTACHMENT_PART_BYTES))) {
      throw new Error('Attachment parts are incomplete');
    }
    const body = `<CompleteMultipartUpload>${completed.map(part =>
      `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${xmlEscape(part.etag)}</ETag></Part>`).join('')}</CompleteMultipartUpload>`;
    const xml = await requireOk(await request('POST', { uploadId: id }, body, { 'content-type': 'application/xml' }));
    // S3 can return a 200 response containing an embedded completion error.
    if (!xml.includes('<CompleteMultipartUploadResult')) throw new Error('R2 failed to complete attachment');
    await fence();
    await abortIncomplete();
    return { key, reference: key, completed: true };
  };

  if (action === 'abort') return abort();
  await fence();
  if (action === 'prepare') return prepare();
  // Never trust a client-supplied uploadId: bind it to the computed uploader key.
  if (!uploadId || !(await uploads()).includes(uploadId)) throw new Error('Unknown attachment upload');
  if (action === 'part') return signPart(uploadId);
  if (action === 'complete') return complete(uploadId);
  throw new Error('Invalid attachment operation');
}

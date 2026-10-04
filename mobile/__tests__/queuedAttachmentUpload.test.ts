import RNFS from 'react-native-fs';
import { bearerAuthHeaders } from '../src/authHeaders';
import { AttachmentError, ATTACHMENT_CANCELLED_MESSAGE, putAttachment } from '../src/attachmentUpload';
import { drainAttachmentUpload, queuedUploadRequest, releaseQueuedAttachment } from '../src/queuedAttachmentUpload';
import type { OutboxItem } from '../src/messaging/types';

jest.mock('react-native-fs', () => ({
  CachesDirectoryPath: '/cache', DocumentDirectoryPath: '/docs',
  read: jest.fn(async () => 'cGFydA=='), writeFile: jest.fn(async () => {}),
  unlink: jest.fn(async () => {}),
  readDir: jest.fn(async () => []),
}));
jest.mock('../src/attachmentUpload', () => ({
  ...jest.requireActual('../src/attachmentUpload'), putAttachment: jest.fn(),
}));
jest.mock('../src/appLogger', () => ({ logInfo: jest.fn(), logWarn: jest.fn() }));

const PART = 5 * 1024 * 1024;
const KEY = 'chatblobs/alice_bob/upload.pdf';
const signed = () => ({
  key: KEY, reference: KEY, uploadUrl: 'https://private.test/?X-Amz-Signature=ephemeral',
  expiresAt: new Date(Date.now() + 60_000).toISOString(), headers: { 'Content-Length': '100' },
});
function row(sizeBytes = 100): OutboxItem {
  return {
    messageId: 'client-1', recipientId: 'bob', body: '', type: 'file',
    attachment: { url: 'file:///docs/source', mimeType: 'application/pdf', sizeBytes },
    upload: { uri: 'file:///docs/source', parts: [], progress: 0 },
  };
}
function worker(item = row(), handler: (body: any) => any = () => signed()) {
  const bodies: any[] = [];
  const authedFetch = jest.fn(async build => {
    const request = build('session');
    const body = JSON.parse(request.options.body);
    bodies.push(body);
    return { ok: true, json: async () => handler(body) } as Response;
  });
  const checkpoints: any[] = [];
  const checkpoint = jest.fn(async upload => {
    checkpoints.push(JSON.parse(JSON.stringify(upload)));
    item.upload = upload;
  });
  return {
    bodies, checkpoints, authedFetch,
    args: { item, authedFetch, signalingUrl: 'https://signal', checkpoint,
      isCurrent: () => true, onProgress: jest.fn(), onAbortHandle: jest.fn() },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  (putAttachment as jest.Mock).mockReset().mockResolvedValue('"etag"');
});

test('renews an expired storage grant at drain, reuses the key and persists no URLs', async () => {
  (putAttachment as jest.Mock).mockRejectedValueOnce(new AttachmentError('Expired', 403)).mockResolvedValueOnce('');
  const w = worker();
  expect(await drainAttachmentUpload(w.args)).toBe(KEY);
  expect(w.bodies.map(body => body.action)).toEqual(['prepare', 'prepare']);
  expect(putAttachment).toHaveBeenCalledTimes(2);
  expect(w.args.item.upload).toMatchObject({ completed: true, progress: 1, key: KEY });
  expect(JSON.stringify(w.checkpoints)).not.toContain('X-Amz');
  expect(JSON.stringify(w.checkpoints)).not.toContain('https://');
});

test('expiry renewals are bounded to three PUT attempts; network failures do not renew', async () => {
  (putAttachment as jest.Mock).mockRejectedValue(new AttachmentError('Expired', 403));
  const w = worker();
  await expect(drainAttachmentUpload(w.args)).rejects.toMatchObject({ status: 403 });
  expect(putAttachment).toHaveBeenCalledTimes(3);
  expect(w.bodies).toHaveLength(3);
  (putAttachment as jest.Mock).mockClear().mockRejectedValue(new AttachmentError('Network'));
  const network = worker();
  await expect(drainAttachmentUpload(network.args)).rejects.toThrow('Network');
  expect(network.bodies).toHaveLength(1);
  expect(putAttachment).toHaveBeenCalledTimes(1);
});

test('already-expired presigns are renewed without sending bytes', async () => {
  const w = worker(row(), () => ({ ...signed(), expiresAt: new Date(0).toISOString() }));
  await expect(drainAttachmentUpload(w.args)).rejects.toMatchObject({ status: 403 });
  expect(w.bodies).toHaveLength(3);
  expect(putAttachment).not.toHaveBeenCalled();
});

test('multipart interruption checkpoints completed parts and restart skips their bytes', async () => {
  const item = row(PART * 2 + 100);
  let remoteParts: any[] = [];
  const handler = (body: any) => body.action === 'prepare'
    ? { ...signed(), uploadId: 'durable-id', partSize: PART, parts: remoteParts }
    : signed();
  (putAttachment as jest.Mock).mockResolvedValueOnce('"one"').mockRejectedValueOnce(new AttachmentError('Disconnected'));
  const first = worker(item, handler);
  await expect(drainAttachmentUpload(first.args)).rejects.toThrow('Disconnected');
  expect(item.upload).toMatchObject({
    uploadId: 'durable-id', progress: PART / (PART * 2 + 100),
    parts: [{ partNumber: 1, etag: '"one"', sizeBytes: PART }],
  });
  remoteParts = item.upload!.parts;
  const restarted = row(PART * 2 + 100);
  restarted.upload = JSON.parse(JSON.stringify(item.upload));
  (putAttachment as jest.Mock).mockReset().mockResolvedValue('"remaining"');
  const second = worker(restarted, handler);
  expect(await drainAttachmentUpload(second.args)).toBe(KEY);
  expect(second.bodies.filter(body => body.action === 'part').map(body => body.partNumber)).toEqual([2, 3]);
  expect(second.bodies.filter(body => body.action === 'complete')).toHaveLength(1);
  expect(putAttachment).toHaveBeenCalledTimes(2);
  expect(RNFS.read).toHaveBeenLastCalledWith('/docs/source', 100, PART * 2, 'base64');
  expect(restarted.upload!.parts).toHaveLength(3);
  expect(restarted.upload!.completed).toBe(true);
  expect(JSON.stringify(second.checkpoints)).not.toContain('X-Amz');
});

test('R2 reconciles a successful part whose local checkpoint was lost', async () => {
  const w = worker(row(PART + 100), body => body.action === 'prepare'
    ? { ...signed(), uploadId: 'recovered', partSize: PART,
      parts: [{ partNumber: 1, etag: '"remote"', sizeBytes: PART }] }
    : signed());
  await drainAttachmentUpload(w.args);
  expect(w.bodies.filter(body => body.action === 'part').map(body => body.partNumber)).toEqual([2]);
  expect(putAttachment).toHaveBeenCalledTimes(1);
});

test('a lost completion response is recovered by prepare without another upload', async () => {
  const w = worker(row(PART + 100), () => ({ ...signed(), completed: true }));
  await expect(drainAttachmentUpload(w.args)).resolves.toBe(KEY);
  expect(putAttachment).not.toHaveBeenCalled();
  expect(w.args.item.upload).toMatchObject({ completed: true, progress: 1 });
});

test('discard during initiation cannot checkpoint or continue a stale worker', async () => {
  let active = true;
  const w = worker(row(), () => { active = false; return signed(); });
  w.args.isCurrent = () => active;
  await expect(drainAttachmentUpload(w.args)).rejects.toThrow(ATTACHMENT_CANCELLED_MESSAGE);
  expect(w.args.checkpoint).not.toHaveBeenCalled();
  expect(putAttachment).not.toHaveBeenCalled();
});

test('discard during a part upload aborts XHR and never completes the multipart', async () => {
  const w = worker(row(PART + 100), body => body.action === 'prepare'
    ? { ...signed(), uploadId: 'pending', partSize: PART, parts: [] } : signed());
  let active = true;
  const abort = jest.fn();
  w.args.isCurrent = () => active;
  (putAttachment as jest.Mock).mockImplementation(async ({ onAbortHandle }) => {
    onAbortHandle(abort);
    active = false;
    abort();
    throw new AttachmentError(ATTACHMENT_CANCELLED_MESSAGE);
  });
  await expect(drainAttachmentUpload(w.args)).rejects.toThrow(ATTACHMENT_CANCELLED_MESSAGE);
  expect(abort).toHaveBeenCalledTimes(1);
  expect(w.bodies.some(body => body.action === 'complete')).toBe(false);
  expect(RNFS.unlink).toHaveBeenCalled();
});

test('cleanup targets the original identity and group scope without serializing signed URLs', async () => {
  const item = { ...row(), targetKind: 'group' as const, conversationId: 'group-1' };
  const w = worker(item);
  await queuedUploadRequest(w.authedFetch, 'https://signal', item, 'abort');
  expect(w.bodies[0]).toMatchObject({ action: 'abort', clientId: 'client-1', groupId: 'group-1' });
  expect(w.bodies[0]).not.toHaveProperty('peerId');
  expect(w.bodies[0]).not.toHaveProperty('uploadUrl');
  expect(w.bodies[0]).not.toHaveProperty('sessionId');
  const build = w.authedFetch.mock.calls[0][0];
  expect(build('session').options.headers).toEqual(bearerAuthHeaders('session', { 'Content-Type': 'application/json' }));
});

test('a session refresh after account switch cannot issue a stale authenticated upload request', async () => {
  let active = true;
  const requests: object[] = [];
  const authedFetch = jest.fn(async build => {
    active = false;
    requests.push(build('another-account-session'));
    return null;
  });
  await expect(queuedUploadRequest(authedFetch, 'https://signal', row(), 'prepare', {}, () => active))
    .rejects.toThrow(ATTACHMENT_CANCELLED_MESSAGE);
  expect(requests).toEqual([]);
});

test('final local cleanup removes only this upload source and interrupted slices', async () => {
  (RNFS.readDir as jest.Mock).mockResolvedValueOnce([
    { name: 'wetalk-part-client-1-2-interrupted', path: '/cache/owned', isFile: () => true },
    { name: 'wetalk-part-client-2-1-other', path: '/cache/other', isFile: () => true },
    { name: 'unrelated', path: '/cache/unrelated', isFile: () => true },
  ]);
  await releaseQueuedAttachment('file:///docs/wetalk-upload-client-1');
  expect(RNFS.unlink).toHaveBeenCalledWith('/docs/wetalk-upload-client-1');
  expect(RNFS.unlink).toHaveBeenCalledWith('/cache/owned');
  expect(RNFS.unlink).not.toHaveBeenCalledWith('/cache/other');
  expect(RNFS.unlink).not.toHaveBeenCalledWith('/cache/unrelated');
  (RNFS.unlink as jest.Mock).mockClear();
  await releaseQueuedAttachment('file:///docs/not-ours');
  expect(RNFS.unlink).not.toHaveBeenCalled();
});

import {
  _resetAttachmentAvailabilityCache,
  describeAttachmentError,
  isAttachmentUploadKnownUnavailable,
  presignAttachment,
  putAttachment,
  uploadAttachment,
  validateAttachment,
} from '../src/attachmentUpload';
import { MESSAGE_TYPES } from '../../shared';

/** Minimal fake XMLHttpRequest driving `putAttachment`'s XHR usage. */
class FakeXHR {
  static instances: any;
  onerror: () => void;
  onload: () => void;
  status: number;
  body: undefined;
  url: string;
  method: string;
  requestHeaders: Record<string, string>;
  upload: any;
  constructor() {
    this.upload = {};
    this.requestHeaders = {};
    this.method = '';
    this.url = '';
    this.body = undefined;
    this.status = 0;
    this.onload = (): void => {};
    this.onerror = (): void => {};
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.requestHeaders[name] = value;
  }
  send(body: any) {
    this.body = body;
    FakeXHR.instances.push(this);
  }
}
/** @type {FakeXHR[]} */
FakeXHR.instances = [];

describe('attachmentUpload', () => {
  beforeEach(() => {
    _resetAttachmentAvailabilityCache();
    FakeXHR.instances = [];
    global.XMLHttpRequest = (FakeXHR as any);
  });

  describe('validateAttachment', () => {
    test('rejects an unsupported type', () => {
      expect(validateAttachment({ type: 'sticker', mimeType: 'image/png', sizeBytes: 10 })).toEqual({
        ok: false,
        message: expect.any(String),
      });
    });

    test('rejects a disallowed MIME type for the given type', () => {
      const result = validateAttachment({
        type: MESSAGE_TYPES.IMAGE,
        mimeType: 'application/pdf',
        sizeBytes: 10,
      });
      expect(result.ok).toBe(false);
    });

    test('rejects a size over the per-type cap', () => {
      const result = validateAttachment({
        type: MESSAGE_TYPES.IMAGE,
        mimeType: 'image/png',
        sizeBytes: 11 * 1024 * 1024,
      });
      expect(result).toEqual({ ok: false, message: expect.stringContaining('10 MB') });
    });

    test('accepts a valid image description', () => {
      expect(
        validateAttachment({ type: MESSAGE_TYPES.IMAGE, mimeType: 'image/png', sizeBytes: 1024 }),
      ).toEqual({ ok: true });
    });

    // Regression guard: a real `voiceRecorder.stopVoiceRecording()` result
    // must pass validation. This previously slipped through because tests
    // mocked `uploadAttachment` for the voice-note path instead of feeding
    // the recorder's real output shape through the real validator — the
    // recorder never populated `sizeBytes`, so every voice note was silently
    // rejected here with "Could not determine the file size".
    test('accepts a voice-note description shaped like voiceRecorder.stopVoiceRecording()', () => {
      expect(
        validateAttachment({
          type: MESSAGE_TYPES.VOICE,
          mimeType: 'audio/aac',
          sizeBytes: 4096,
        }),
      ).toEqual({ ok: true });
    });
  });

  describe('describeAttachmentError', () => {
    test.each([
      [503, "Attachments aren't available on this server"],
      [413, 'That file is too large to send'],
      [429, "You're sending too fast — try again in a moment"],
      [403, 'You cannot send attachments to this contact'],
      [401, 'Your session expired — try again'],
      [500, 'The server could not process the upload — try again'],
      [undefined, 'Network problem — check your connection and retry'],
    ])('maps status %s', (status, expected) => {
      expect(describeAttachmentError({ status })).toBe(expected);
    });

    test('surfaces the server message for other 4xx statuses', () => {
      expect(describeAttachmentError({ status: 400, message: 'peerId must be another user' })).toBe(
        'peerId must be another user',
      );
    });
  });

  describe('presignAttachment', () => {
    function buildAuthedFetch(/** @type {any} */ response: any) {
      return jest.fn((/** @type {any} */ build: any) => {
        build('session-1');
        return Promise.resolve(response);
      });
    }

    test('posts the expected body and returns the presign payload on success', async () => {
      const payload = {
        conversationId: 'conv-1',
        key: 'chatblobs/conv-1/x.png',
        uploadUrl: 'https://r2.example/upload',
        publicUrl: 'https://cdn.example/chatblobs/conv-1/x.png',
        expiresAt: '2024-01-01T00:00:00.000Z',
        headers: { 'Content-Type': 'image/png', 'Content-Length': '10' },
      };
      const authedFetch = buildAuthedFetch({ ok: true, json: () => Promise.resolve(payload) });

      const result = await presignAttachment({
        authedFetch,
        signalingUrl: 'https://signal.example',
        peerId: 'user-bob',
        type: MESSAGE_TYPES.IMAGE,
        mimeType: 'image/png',
        sizeBytes: 10,
      });

      expect(result).toEqual(payload);
      const [buildRequest] = authedFetch.mock.calls[0];
      const request = buildRequest('session-1');
      expect(request.url).toBe('https://signal.example/attachments/presign');
      expect(JSON.parse(request.options.body)).toEqual({
        sessionId: 'session-1',
        peerId: 'user-bob',
        type: MESSAGE_TYPES.IMAGE,
        mimeType: 'image/png',
        sizeBytes: 10,
      });
    });

    test('marks attachments unavailable and throws on a 503', async () => {
      const authedFetch = buildAuthedFetch({
        ok: false,
        status: 503,
        json: () => Promise.resolve({ error: 'attachment uploads are not configured' }),
      });

      expect(isAttachmentUploadKnownUnavailable()).toBe(false);
      await expect(
        presignAttachment({
          authedFetch,
          signalingUrl: 'https://signal.example',
          peerId: 'user-bob',
          type: MESSAGE_TYPES.IMAGE,
          mimeType: 'image/png',
          sizeBytes: 10,
        }),
      ).rejects.toMatchObject({ status: 503, message: 'attachment uploads are not configured' });
      expect(isAttachmentUploadKnownUnavailable()).toBe(true);
    });

    test('throws when authedFetch could not establish a session', async () => {
      const authedFetch = jest.fn(() => Promise.resolve(null));
      await expect(
        presignAttachment({
          authedFetch,
          signalingUrl: 'https://signal.example',
          peerId: 'user-bob',
          type: MESSAGE_TYPES.IMAGE,
          mimeType: 'image/png',
          sizeBytes: 10,
        }),
      ).rejects.toMatchObject({ message: 'Could not reach the server' });
    });
  });

  describe('putAttachment', () => {
    test('replays the presigned headers verbatim and resolves on 2xx', async () => {
      const onProgress = jest.fn();
      const promise = putAttachment({
        uploadUrl: 'https://r2.example/upload',
        headers: { 'Content-Type': 'image/png', 'Content-Length': '10' },
        body: { uri: 'file:///tmp/photo.png' },
        onProgress,
      });

      const xhr = FakeXHR.instances[0];
      expect(xhr.method).toBe('PUT');
      expect(xhr.url).toBe('https://r2.example/upload');
      expect(xhr.requestHeaders).toEqual({ 'Content-Type': 'image/png', 'Content-Length': '10' });

      xhr.upload.onprogress({ lengthComputable: true, loaded: 5, total: 10 });
      expect(onProgress).toHaveBeenCalledWith(0.5);

      xhr.status = 200;
      xhr.onload();
      await expect(promise).resolves.toBeUndefined();
      expect(onProgress).toHaveBeenCalledWith(1);
    });

    test('rejects with the status on a non-2xx response', async () => {
      const promise = putAttachment({
        uploadUrl: 'https://r2.example/upload',
        headers: {},
        body: ({} as any),
      });
      const xhr = FakeXHR.instances[0];
      xhr.status = 403;
      xhr.onload();
      await expect(promise).rejects.toMatchObject({ status: 403, message: expect.any(String) });
    });

    test('rejects on a network error', async () => {
      const promise = putAttachment({ uploadUrl: 'https://r2.example/upload', headers: {}, body: ({} as any) });
      FakeXHR.instances[0].onerror();
      await expect(promise).rejects.toMatchObject({ message: expect.any(String) });
    });
  });

  describe('uploadAttachment (full pipeline)', () => {
    test('validates before ever calling presign', async () => {
      const authedFetch = jest.fn();
      await expect(
        uploadAttachment({
          authedFetch,
          signalingUrl: 'https://signal.example',
          peerId: 'user-bob',
          type: MESSAGE_TYPES.IMAGE,
          uri: 'file:///tmp/x.png',
          mimeType: 'application/zip',
          sizeBytes: 10,
        }),
      ).rejects.toMatchObject({ message: expect.any(String) });
      expect(authedFetch).not.toHaveBeenCalled();
    });

    test('presigns, PUTs, and resolves the attachment fields on success', async () => {
      const payload = {
        conversationId: 'conv-1',
        key: 'chatblobs/conv-1/x.png',
        uploadUrl: 'https://r2.example/upload',
        publicUrl: 'https://cdn.example/chatblobs/conv-1/x.png',
        expiresAt: '2024-01-01T00:00:00.000Z',
        headers: { 'Content-Type': 'image/png', 'Content-Length': '1024' },
      };
      const authedFetch = (jest.fn((/** @type {any} */ build: any) => {
          build('session-1');
          return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });
        }) as any);

      const promise = uploadAttachment({
        authedFetch,
        signalingUrl: 'https://signal.example',
        peerId: 'user-bob',
        type: MESSAGE_TYPES.IMAGE,
        uri: 'file:///tmp/x.png',
        mimeType: 'image/png',
        sizeBytes: 1024,
        width: 800,
        height: 600,
      });

      // Wait for presign to resolve (response.json()) and putAttachment to
      // call xhr.send() before driving the fake XHR's response.
      for (let i = 0; i < 5 && FakeXHR.instances.length === 0; i += 1) {
        await Promise.resolve();
      }
      const xhr = FakeXHR.instances[0];
      xhr.status = 200;
      xhr.onload();

      await expect(promise).resolves.toEqual({
        url: payload.publicUrl,
        mimeType: 'image/png',
        sizeBytes: 1024,
        width: 800,
        height: 600,
      });
    });

    test('maps a 503 presign failure to the user-facing message', async () => {
      const authedFetch = (jest.fn(() =>
          Promise.resolve({
            ok: false,
            status: 503,
            json: () => Promise.resolve({ error: 'not configured' }),
          }),
        ) as any);

      await expect(
        uploadAttachment({
          authedFetch,
          signalingUrl: 'https://signal.example',
          peerId: 'user-bob',
          type: MESSAGE_TYPES.IMAGE,
          uri: 'file:///tmp/x.png',
          mimeType: 'image/png',
          sizeBytes: 1024,
        }),
      ).rejects.toMatchObject({
        status: 503,
        message: "Attachments aren't available on this server",
      });
    });
  });
});

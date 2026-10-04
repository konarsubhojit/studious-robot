import React from 'react';
import renderer, { act } from 'react-test-renderer';
import useAttachments from '../../src/hooks/useAttachments';
import { pickCameraPhoto, pickDocument, pickPhoto } from '../../src/attachmentPicker';
import { ensureAttachmentPermission } from '../../src/permissions';
import { startVoiceRecording, stopVoiceRecording } from '../../src/voiceRecorder';
import {
  ATTACHMENT_CANCELLED_MESSAGE,
  _resetAttachmentAvailabilityCache,
  uploadAttachment,
} from '../../src/attachmentUpload';
import { MESSAGE_TYPES } from '../../../shared';

jest.mock('../../src/attachmentPicker', () => ({
  pickPhoto: jest.fn(),
  pickCameraPhoto: jest.fn(),
  pickDocument: jest.fn(),
}));
jest.mock('../../src/voiceRecorder', () => ({
  isVoiceRecorderAvailable: jest.fn(() => true),
  startVoiceRecording: jest.fn(),
  stopVoiceRecording: jest.fn(),
}));
jest.mock('../../src/permissions', () => ({
  ensureAttachmentPermission: jest.fn(),
}));
jest.mock('../../src/attachmentUpload', () => ({
  ...jest.requireActual('../../src/attachmentUpload'),
  uploadAttachment: jest.fn(),
}));

function TestHook({ resultRef, params }: any) {
  resultRef.current = useAttachments(params);
  return null;
}

function setup(overrides = {}) {
  const resultRef: { current: any; } = { current: null };
  const params = {
    authedFetchRef: { current: jest.fn() },
    signalingUrl: 'https://signal.example.com',
    beginAttachmentUpload: jest.fn(() => 'local-1'),
    updateAttachmentUploadProgress: jest.fn(),
    finishAttachmentUpload: jest.fn(),
    failAttachmentUpload: jest.fn(),
    discardAttachmentUpload: jest.fn(),
    updateStatus: jest.fn(),
    ...overrides,
  };
  act(() => {
    renderer.create(<TestHook resultRef={resultRef} params={params} />);
  });
  return { resultRef, params };
}

beforeEach(() => {
  jest.clearAllMocks();
  (ensureAttachmentPermission as jest.Mock).mockResolvedValue({ ok: true, granted: true, message: null });
  _resetAttachmentAvailabilityCache();
});

describe('useAttachments', () => {
  test('pickAndSend(photo): inserts a bubble then queues a local descriptor without presigning', async () => {
    (pickPhoto as jest.Mock).mockResolvedValue({ uri: 'file:///a.jpg', mimeType: 'image/jpeg', sizeBytes: 100 });
    (uploadAttachment as jest.Mock).mockResolvedValue({ url: 'https://cdn/a.jpg', mimeType: 'image/jpeg', sizeBytes: 100 });
    const { resultRef, params } = setup();

    await act(async () => {
      await resultRef.current.pickAndSend('user-bob', 'photo');
    });

    expect(ensureAttachmentPermission).toHaveBeenCalledWith('photo');
    expect(params.beginAttachmentUpload).toHaveBeenCalledWith('user-bob', MESSAGE_TYPES.IMAGE, {
      url: 'file:///a.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 100,
      name: undefined,
      width: undefined,
      height: undefined,
      durationMs: undefined,
    });
    expect(params.beginAttachmentUpload.mock.invocationCallOrder[0]).toBeLessThan(
      params.finishAttachmentUpload.mock.invocationCallOrder[0],
    );
    expect(uploadAttachment).not.toHaveBeenCalled();
    expect(params.authedFetchRef.current).not.toHaveBeenCalled();
    expect(params.finishAttachmentUpload).toHaveBeenCalledWith(
      'user-bob',
      'local-1',
      MESSAGE_TYPES.IMAGE,
      { url: 'file:///a.jpg', mimeType: 'image/jpeg', sizeBytes: 100 },
    );
  });

  test('pickAndSend(file): sends as a FILE message', async () => {
    (pickDocument as jest.Mock).mockResolvedValue({ uri: 'file:///a.pdf', mimeType: 'application/pdf', sizeBytes: 100 });
    (uploadAttachment as jest.Mock).mockResolvedValue({ url: 'https://cdn/a.pdf' });
    const { resultRef, params } = setup();

    await act(async () => {
      await resultRef.current.pickAndSend('user-bob', 'file');
    });

    expect(params.finishAttachmentUpload).toHaveBeenCalledWith(
      'user-bob',
      'local-1',
      MESSAGE_TYPES.FILE,
      { url: 'file:///a.pdf', mimeType: 'application/pdf', sizeBytes: 100 },
    );
  });

  test('pickAndSend does nothing when the permission is denied', async () => {
    (ensureAttachmentPermission as jest.Mock).mockResolvedValue({ ok: false, message: 'Camera permission is required' });
    const { resultRef, params } = setup();

    await act(async () => {
      await resultRef.current.pickAndSend('user-bob', 'camera');
    });

    expect(pickCameraPhoto).not.toHaveBeenCalled();
    expect(params.updateStatus).toHaveBeenCalledWith('Camera permission is required', 'error');
  });

  test('pickAndSend does nothing when the user cancels the picker', async () => {
    (pickPhoto as jest.Mock).mockResolvedValue(null);
    const { resultRef, params } = setup();

    await act(async () => {
      await resultRef.current.pickAndSend('user-bob', 'photo');
    });

    expect(uploadAttachment).not.toHaveBeenCalled();
    expect(params.finishAttachmentUpload).not.toHaveBeenCalled();
  });

  test('marks attachmentsAvailable false and surfaces the message on a 503', async () => {
    (pickPhoto as jest.Mock).mockResolvedValue({ uri: 'file:///a.jpg', mimeType: 'image/jpeg', sizeBytes: 100 });
    const finishAttachmentUpload = jest.fn().mockRejectedValue({
      status: 503,
      message: "Attachments aren't available on this server",
    });
    const { resultRef, params } = setup({ finishAttachmentUpload });

    expect(resultRef.current.attachmentsAvailable).toBe(true);

    await act(async () => {
      await resultRef.current.pickAndSend('user-bob', 'photo');
    });

    expect(resultRef.current.attachmentsAvailable).toBe(false);
    expect(params.updateStatus).toHaveBeenCalledWith(
      "Attachments aren't available on this server",
      'error',
    );
  });

  test('records and sends a voice note', async () => {
    (startVoiceRecording as jest.Mock).mockResolvedValue(true);
    (stopVoiceRecording as jest.Mock).mockResolvedValue({
      uri: 'file:///v.m4a',
      mimeType: 'audio/aac',
      durationMs: 2000,
      sizeBytes: 4096,
    });
    (uploadAttachment as jest.Mock).mockResolvedValue({ url: 'https://cdn/v.m4a' });
    const { resultRef, params } = setup();

    await act(async () => {
      await resultRef.current.startRecordingVoiceNote();
    });
    expect(resultRef.current.isRecordingVoiceNote).toBe(true);

    await act(async () => {
      await resultRef.current.stopRecordingVoiceNoteAndSend('user-bob');
    });

    expect(resultRef.current.isRecordingVoiceNote).toBe(false);
    expect(params.finishAttachmentUpload).toHaveBeenCalledWith(
      'user-bob',
      'local-1',
      MESSAGE_TYPES.VOICE,
      { url: 'file:///v.m4a', mimeType: 'audio/aac', sizeBytes: 4096, durationMs: 2000 },
    );
  });
});

describe('useAttachments cancellation', () => {
  test('cancelUpload discards composition while its durable copy is pending', async () => {
    (pickPhoto as jest.Mock).mockResolvedValue({ uri: 'file:///a.jpg', mimeType: 'image/jpeg', sizeBytes: 100 });

    let complete!: () => void;
    const finishAttachmentUpload = jest.fn(() => new Promise<void>(resolve => { complete = resolve; }));
    const { resultRef, params } = setup({ finishAttachmentUpload });

    let pending: Promise<void>;
    act(() => {
      pending = resultRef.current.pickAndSend('user-bob', 'photo');
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(resultRef.current.isUploading).toBe(true);

    await act(async () => {
      resultRef.current.cancelUpload();
      complete();
      await pending;
    });

    expect(params.failAttachmentUpload).toHaveBeenCalledWith(
      'user-bob',
      'local-1',
      ATTACHMENT_CANCELLED_MESSAGE,
    );
    expect(params.updateStatus).toHaveBeenCalledWith('Upload cancelled', 'info');
    expect(params.discardAttachmentUpload).toHaveBeenCalledWith('user-bob', 'local-1');
    expect(uploadAttachment).not.toHaveBeenCalled();
    expect(resultRef.current.isUploading).toBe(false);
    expect(resultRef.current.attachmentsAvailable).toBe(true);
  });

  test('cancelUpload is a no-op when nothing is uploading', () => {
    const { resultRef, params } = setup();
    expect(() => resultRef.current.cancelUpload()).not.toThrow();
    expect(params.updateStatus).not.toHaveBeenCalled();
  });
});

// @ts-check
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import useAttachments from '../../src/hooks/useAttachments';
import { pickCameraPhoto, pickDocument, pickPhoto } from '../../src/attachmentPicker';
import { ensureAttachmentPermission } from '../../src/permissions';
import { startVoiceRecording, stopVoiceRecording } from '../../src/voiceRecorder';
import { _resetAttachmentAvailabilityCache, uploadAttachment } from '../../src/attachmentUpload';
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

function TestHook(/** @type {any} */ { resultRef, params }) {
  resultRef.current = useAttachments(params);
  return null;
}

function setup(overrides = {}) {
  /** @type {{ current: any }} */
  const resultRef = { current: null };
  const params = {
    authedFetchRef: { current: jest.fn() },
    signalingUrl: 'https://signal.example.com',
    sendMessage: jest.fn(),
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
  /** @type {jest.Mock} */ (ensureAttachmentPermission).mockResolvedValue({ ok: true, granted: true, message: null });
  _resetAttachmentAvailabilityCache();
});

describe('useAttachments', () => {
  test('pickAndSend(photo): uploads the picked photo and sends it', async () => {
    /** @type {jest.Mock} */ (pickPhoto).mockResolvedValue({ uri: 'file:///a.jpg', mimeType: 'image/jpeg', sizeBytes: 100 });
    /** @type {jest.Mock} */ (uploadAttachment).mockResolvedValue({ url: 'https://cdn/a.jpg', mimeType: 'image/jpeg', sizeBytes: 100 });
    const { resultRef, params } = setup();

    await act(async () => {
      await resultRef.current.pickAndSend('user-bob', 'photo');
    });

    expect(ensureAttachmentPermission).toHaveBeenCalledWith('photo');
    expect(uploadAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ peerId: 'user-bob', type: MESSAGE_TYPES.IMAGE, uri: 'file:///a.jpg' }),
    );
    expect(params.sendMessage).toHaveBeenCalledWith('user-bob', '', {
      type: MESSAGE_TYPES.IMAGE,
      attachment: { url: 'https://cdn/a.jpg', mimeType: 'image/jpeg', sizeBytes: 100 },
    });
  });

  test('pickAndSend(file): sends as a FILE message', async () => {
    /** @type {jest.Mock} */ (pickDocument).mockResolvedValue({ uri: 'file:///a.pdf', mimeType: 'application/pdf', sizeBytes: 100 });
    /** @type {jest.Mock} */ (uploadAttachment).mockResolvedValue({ url: 'https://cdn/a.pdf' });
    const { resultRef, params } = setup();

    await act(async () => {
      await resultRef.current.pickAndSend('user-bob', 'file');
    });

    expect(params.sendMessage).toHaveBeenCalledWith(
      'user-bob',
      '',
      expect.objectContaining({ type: MESSAGE_TYPES.FILE }),
    );
  });

  test('pickAndSend does nothing when the permission is denied', async () => {
    /** @type {jest.Mock} */ (ensureAttachmentPermission).mockResolvedValue({ ok: false, message: 'Camera permission is required' });
    const { resultRef, params } = setup();

    await act(async () => {
      await resultRef.current.pickAndSend('user-bob', 'camera');
    });

    expect(pickCameraPhoto).not.toHaveBeenCalled();
    expect(params.updateStatus).toHaveBeenCalledWith('Camera permission is required', 'error');
  });

  test('pickAndSend does nothing when the user cancels the picker', async () => {
    /** @type {jest.Mock} */ (pickPhoto).mockResolvedValue(null);
    const { resultRef, params } = setup();

    await act(async () => {
      await resultRef.current.pickAndSend('user-bob', 'photo');
    });

    expect(uploadAttachment).not.toHaveBeenCalled();
    expect(params.sendMessage).not.toHaveBeenCalled();
  });

  test('marks attachmentsAvailable false and surfaces the message on a 503', async () => {
    /** @type {jest.Mock} */ (pickPhoto).mockResolvedValue({ uri: 'file:///a.jpg', mimeType: 'image/jpeg', sizeBytes: 100 });
    /** @type {jest.Mock} */ (uploadAttachment).mockRejectedValue({
      status: 503,
      message: "Attachments aren't available on this server",
    });
    const { resultRef, params } = setup();

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
    /** @type {jest.Mock} */ (startVoiceRecording).mockResolvedValue(true);
    /** @type {jest.Mock} */ (stopVoiceRecording).mockResolvedValue({
      uri: 'file:///v.m4a',
      mimeType: 'audio/aac',
      durationMs: 2000,
      sizeBytes: 4096,
    });
    /** @type {jest.Mock} */ (uploadAttachment).mockResolvedValue({ url: 'https://cdn/v.m4a' });
    const { resultRef, params } = setup();

    await act(async () => {
      await resultRef.current.startRecordingVoiceNote();
    });
    expect(resultRef.current.isRecordingVoiceNote).toBe(true);

    await act(async () => {
      await resultRef.current.stopRecordingVoiceNoteAndSend('user-bob');
    });

    expect(resultRef.current.isRecordingVoiceNote).toBe(false);
    expect(params.sendMessage).toHaveBeenCalledWith(
      'user-bob',
      '',
      expect.objectContaining({ type: MESSAGE_TYPES.VOICE }),
    );
  });
});

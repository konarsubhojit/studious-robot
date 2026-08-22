// @ts-check
import { useCallback, useState } from 'react';
import { MESSAGE_TYPES } from '../../../shared';
import { isAttachmentUploadKnownUnavailable, uploadAttachment } from '../attachmentUpload';
import { pickCameraPhoto, pickDocument, pickPhoto } from '../attachmentPicker';
import { ensureAttachmentPermission } from '../permissions';
import {
  isVoiceRecorderAvailable,
  startVoiceRecording,
  stopVoiceRecording,
} from '../voiceRecorder';

/**
 * Owns the send-side attachment pipeline the composer's attach/mic controls
 * drive: runtime permission → native picker/recorder → upload (validate →
 * presign → `PUT`) → `sendMessage`.
 *
 * A server without R2 configured only reports it on the *first* presign
 * attempt (`503`); this hook remembers that across the whole session
 * (`attachmentUpload`'s cache) so the control degrades to a clear, disabled
 * state instead of dead-ending silently on every subsequent tap — the bug
 * this whole pipeline exists to fix.
 *
 * @param {{
 *   authedFetchRef: { current: Function | null },
 *   signalingUrl: string,
 *   sendMessage: (peerId: string, body: string, options?: object) => Promise<void>,
 *   updateStatus: (message: string, severity?: string) => void,
 * }} params
 */
export default function useAttachments({
  authedFetchRef,
  signalingUrl,
  sendMessage,
  updateStatus,
}) {
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isRecordingVoiceNote, setIsRecordingVoiceNote] = useState(false);
  const [attachmentsAvailable, setAttachmentsAvailable] = useState(
    () => !isAttachmentUploadKnownUnavailable(),
  );

  const authedFetch = useCallback(
    (/** @type {(sessionId: string) => { url: string, options?: object }} */ build) =>
      authedFetchRef.current?.(build) ?? Promise.resolve(null),
    [authedFetchRef],
  );

  const sendPicked = useCallback(
    /**
     * @param {string} peerId
     * @param {string} type
     * @param {any} picked
     */
    async (peerId, type, picked) => {
      if (!picked) return;
      setIsUploading(true);
      setUploadProgress(0);
      try {
        const attachment = await uploadAttachment({
          authedFetch,
          signalingUrl,
          peerId,
          type,
          uri: picked.uri,
          mimeType: picked.mimeType,
          sizeBytes: picked.sizeBytes,
          name: picked.name,
          width: picked.width,
          height: picked.height,
          durationMs: picked.durationMs,
          onProgress: setUploadProgress,
        });
        await sendMessage(peerId, '', { type, attachment });
      } catch (error) {
        const failure = /** @type {{ status?: number, message?: string }} */ (error ?? {});
        if (failure.status === 503) setAttachmentsAvailable(false);
        updateStatus?.(failure.message ?? 'Could not send attachment', 'error');
      } finally {
        setIsUploading(false);
      }
    },
    [authedFetch, signalingUrl, sendMessage, updateStatus],
  );

  /**
   * Run a picker (photo/camera/file) for `peerId` and, once something is
   * picked, upload and send it.
   *
   * @param {string} peerId
   * @param {'photo'|'camera'|'file'} kind
   */
  const pickAndSend = useCallback(
    /**
     * @param {string} peerId
     * @param {'photo'|'camera'|'file'} kind
     */
    async (peerId, kind) => {
      const permission = await ensureAttachmentPermission(kind);
      if (!permission.ok) {
        updateStatus?.(permission.message ?? 'Permission denied', 'error');
        return;
      }

      let picked = null;
      if (kind === 'photo') picked = await pickPhoto();
      else if (kind === 'camera') picked = await pickCameraPhoto();
      else if (kind === 'file') picked = await pickDocument();
      if (!picked) return;

      const type = kind === 'file' ? MESSAGE_TYPES.FILE : MESSAGE_TYPES.IMAGE;
      await sendPicked(peerId, type, picked);
    },
    [sendPicked, updateStatus],
  );

  /** Begin recording a voice note. */
  const startRecordingVoiceNote = useCallback(async () => {
    const permission = await ensureAttachmentPermission('voice');
    if (!permission.ok) {
      updateStatus?.(permission.message ?? 'Permission denied', 'error');
      return;
    }
    const started = await startVoiceRecording();
    setIsRecordingVoiceNote(started);
  }, [updateStatus]);

  /** Stop recording and send the resulting voice note to `peerId`. */
  const stopRecordingVoiceNoteAndSend = useCallback(
    async (/** @type {string} */ peerId) => {
      setIsRecordingVoiceNote(false);
      const recorded = await stopVoiceRecording();
      if (!recorded) return;
      await sendPicked(peerId, MESSAGE_TYPES.VOICE, recorded);
    },
    [sendPicked],
  );

  /** Stop recording without sending (e.g. the user cancels). */
  const cancelRecordingVoiceNote = useCallback(async () => {
    setIsRecordingVoiceNote(false);
    await stopVoiceRecording().catch(() => {});
  }, []);

  return {
    pickAndSend,
    startRecordingVoiceNote,
    stopRecordingVoiceNoteAndSend,
    cancelRecordingVoiceNote,
    isUploading,
    uploadProgress,
    isRecordingVoiceNote,
    attachmentsAvailable,
    isVoiceNoteSupported: isVoiceRecorderAvailable(),
  };
}

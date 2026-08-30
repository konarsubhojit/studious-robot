import { useCallback, useMemo, useRef, useState } from 'react';
import { MESSAGE_TYPES } from '../../../shared';
import {
  ATTACHMENT_CANCELLED_MESSAGE,
  isAttachmentUploadKnownUnavailable,
  uploadAttachment,
} from '../attachmentUpload';
import { pickCameraPhoto, pickDocument, pickPhoto } from '../attachmentPicker';
import { ensureAttachmentPermission } from '../permissions';
import type { CallStatus } from '../components/StatusBanner';
import type { ChatMessage } from './useMessaging';
import type { AttachmentRecord } from '../../../shared/signaling/schemas';
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
 * @param params
 */
export type UseAttachmentsParams = {
  authedFetchRef: { current: Function | null; };
  signalingUrl: string;
  sendMessage: (peerId: string, body: string, options?: object) => Promise<void>;
  beginAttachmentUpload: (peerId: string, type: string, attachment: Partial<AttachmentRecord>) => string | null;
  updateAttachmentUploadProgress: (peerId: string, messageId: string, progress: number) => void;
  finishAttachmentUpload: (peerId: string, messageId: string, type: string, attachment: AttachmentRecord) => Promise<void>;
  failAttachmentUpload: (peerId: string, messageId: string, error?: string | null) => void;
  updateStatus: (message: string, severity?: CallStatus['severity']) => void;
};

export default function useAttachments({
  authedFetchRef,
  signalingUrl,
  sendMessage,
  beginAttachmentUpload,
  updateAttachmentUploadProgress,
  finishAttachmentUpload,
  failAttachmentUpload,
  updateStatus,
}: UseAttachmentsParams) {
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isRecordingVoiceNote, setIsRecordingVoiceNote] = useState(false);
  const [attachmentsAvailable, setAttachmentsAvailable] = useState(
    () => !isAttachmentUploadKnownUnavailable(),
  );
  // Set for the lifetime of one `PUT`; calling it aborts the XHR, which
  // rejects the upload with ATTACHMENT_CANCELLED_MESSAGE.
  const abortUploadRef = useRef<(() => void) | null>(null);

  const authedFetch = useCallback(
    (build: (sessionId: string) => { url: string; options?: object; }) =>
      authedFetchRef.current?.(build) ?? Promise.resolve(null),
    [authedFetchRef],
  );

  const sendPicked = useCallback(
    async (peerId: string, type: string, picked: any, existingMessageId?: string | null) => {
      if (!picked) return;
      setIsUploading(true);
      setUploadProgress(0);
      const messageId =
        existingMessageId ??
        beginAttachmentUpload(peerId, type, {
          url: picked.uri,
          mimeType: picked.mimeType,
          sizeBytes: picked.sizeBytes,
          name: picked.name,
          width: picked.width,
          height: picked.height,
          durationMs: picked.durationMs,
        });
      if (!messageId) {
        setIsUploading(false);
        return;
      }
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
          onProgress: progress => {
            setUploadProgress(progress);
            updateAttachmentUploadProgress(peerId, messageId, progress);
          },
          onAbortHandle: abort => {
            abortUploadRef.current = abort;
          },
        });
        await finishAttachmentUpload(peerId, messageId, type, attachment);
      } catch (error) {
        const failure = ((error ?? {}) as { status?: number, message?: string });
        failAttachmentUpload(peerId, messageId, failure.message ?? 'Could not send attachment');
        if (failure.message === ATTACHMENT_CANCELLED_MESSAGE) {
          updateStatus?.('Upload cancelled', 'info');
        } else {
          if (failure.status === 503) setAttachmentsAvailable(false);
          updateStatus?.(failure.message ?? 'Could not send attachment', 'error');
        }
      } finally {
        abortUploadRef.current = null;
        setIsUploading(false);
      }
    },
    [
      authedFetch,
      beginAttachmentUpload,
      failAttachmentUpload,
      finishAttachmentUpload,
      signalingUrl,
      updateAttachmentUploadProgress,
      updateStatus,
    ],
  );

  const retryUpload = useCallback(
    async (peerId: string, message: ChatMessage) => {
      const attachment = message?.attachment;
      const uri = attachment?.url;
      if (!message?.messageId || !message.type || !uri) {
        await sendMessage(peerId, message?.body ?? '');
        return;
      }
      await sendPicked(
        peerId,
        message.type,
        {
          uri,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          name: attachment.name,
          width: attachment.width,
          height: attachment.height,
          durationMs: attachment.durationMs,
        },
        message.messageId,
      );
    },
    [sendMessage, sendPicked],
  );

  /**
   * Abort the in-flight upload, if there is one. Safe to call at any time: it
   * is a no-op once the `PUT` has finished or has not started yet.
   */
  const cancelUpload = useCallback(() => {
    const abort = abortUploadRef.current;
    abortUploadRef.current = null;
    abort?.();
  }, []);

  /**
   * Run a picker (photo/camera/file) for `peerId` and, once something is
   * picked, upload and send it.
   */
  const pickAndSend = useCallback(
    async (peerId: string, kind: 'photo' | 'camera' | 'file') => {
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
    async (peerId: string) => {
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

  // Memoised for consistency with every other derived value here; the module
  // load behind it is already cached, so this is about the hook's shape rather
  // than about cost.
  const isVoiceNoteSupported = useMemo(() => isVoiceRecorderAvailable(), []);

  return {
    pickAndSend,
    retryUpload,
    cancelUpload,
    startRecordingVoiceNote,
    stopRecordingVoiceNoteAndSend,
    cancelRecordingVoiceNote,
    isUploading,
    uploadProgress,
    isRecordingVoiceNote,
    attachmentsAvailable,
    isVoiceNoteSupported,
  };
}

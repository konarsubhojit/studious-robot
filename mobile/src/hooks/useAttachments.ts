import { useCallback, useMemo, useRef, useState } from 'react';
import { MESSAGE_TYPES } from '../../../shared';
import {
  ATTACHMENT_CANCELLED_MESSAGE,
  isAttachmentUploadKnownUnavailable,
  validateAttachment,
  AttachmentError,
} from '../attachmentUpload';
import { logInfo, logWarn } from '../appLogger';
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
 * drive: runtime permission → native picker/recorder → validation → durable
 * queue. The outbox worker owns presigning, upload progress, and retries.
 *
 * Composition does not require connectivity. Storage availability failures
 * belong to the queued bubble; local permission/picker/copy failures are
 * surfaced immediately.
 *
 * @param params
 */
export type UseAttachmentsParams = {
  authedFetchRef: { current: Function | null; };
  signalingUrl: string;
  beginAttachmentUpload: (peerId: string, type: string, attachment: Partial<AttachmentRecord>) => string | null;
  updateAttachmentUploadProgress: (peerId: string, messageId: string, progress: number) => void;
  finishAttachmentUpload: (peerId: string, messageId: string, type: string, attachment: AttachmentRecord) => Promise<void>;
  failAttachmentUpload: (peerId: string, messageId: string, error?: string | null) => void;
  discardAttachmentUpload?: (peerId: string, messageId: string) => void;
  updateStatus: (message: string, severity?: CallStatus['severity']) => void;
};

export default function useAttachments({
  beginAttachmentUpload,
  finishAttachmentUpload,
  failAttachmentUpload,
  discardAttachmentUpload,
  updateStatus,
}: UseAttachmentsParams) {
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isRecordingVoiceNote, setIsRecordingVoiceNote] = useState(false);
  const [attachmentsAvailable, setAttachmentsAvailable] = useState(
    () => !isAttachmentUploadKnownUnavailable(),
  );
  // Cancels composition while the app-owned copy is being committed. Bubble
  // cancellation targets its message identity in the outbox, not this ref.
  const abortUploadRef = useRef<(() => void) | null>(null);

  const sendPicked = useCallback(
    async (peerId: string, type: string, picked: any, existingMessageId?: string | null) => {
      if (!picked) return;
      logInfo('[Attachments] picker selected attachment', {
        type,
        rawMimeType: picked.mimeType,
        sizeBytes: picked.sizeBytes,
      });
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
          waveform: picked.waveform,
        });
      if (!messageId) {
        setIsUploading(false);
        return;
      }
      let cancelled = false;
      abortUploadRef.current = () => {
        cancelled = true;
        discardAttachmentUpload?.(peerId, messageId);
      };
      try {
        const validation = validateAttachment({ type, mimeType: picked.mimeType, sizeBytes: picked.sizeBytes });
        if (!validation.ok) throw new AttachmentError(validation.message);
        // Composition queues a local descriptor only. Credentials and binary
        // transfer belong exclusively to the durable outbox worker.
        const { uri, ...metadata } = picked;
        const attachment = { ...metadata, mimeType: picked.mimeType.trim().toLowerCase(), url: uri };
        await finishAttachmentUpload(peerId, messageId, type, attachment);
        if (cancelled) throw new AttachmentError(ATTACHMENT_CANCELLED_MESSAGE);
      } catch (error) {
        const failure = ((error ?? {}) as { status?: number, message?: string });
        logWarn('[Attachments] composer upload error', {
          type,
          status: failure.status,
          message: failure.message ?? 'Could not send attachment',
        });
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
      beginAttachmentUpload,
      discardAttachmentUpload,
      failAttachmentUpload,
      finishAttachmentUpload,
      updateStatus,
    ],
  );

  const retryUpload = useCallback(
    async (peerId: string, message: ChatMessage) => {
      const attachment = message?.attachment;
      const uri = attachment?.url;
      if (!message?.messageId || !message.type || !uri) return;
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
          waveform: attachment.waveform,
        },
        message.messageId,
      );
    },
    [sendPicked],
  );

  /**
   * Cancel a pending composition. Active/queued bubble cancellation is
   * handled by useMessaging.discardMessage.
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
      if (!picked) {
        logInfo('[Attachments] picker returned no attachment', { kind });
        return;
      }

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

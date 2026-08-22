// @ts-check
/**
 * Lazy-loaded wrappers around the native attachment pickers.
 *
 * Follows the same optional-native-module pattern as `vectorIcons.js`: the
 * modules are `require`d at call time via try/catch so the app still boots
 * (and the composer's attach button still degrades gracefully) in CI or a
 * fresh checkout before `pod install` / a native rebuild has linked them.
 */

import { logWarn } from './appLogger';

/** @type {typeof import('react-native-image-picker') | null | undefined} */
let _imagePickerCache;
/** @type {typeof import('@react-native-documents/picker') | null | undefined} */
let _documentPickerCache;

/**
 * @param {unknown} error
 * @returns {string|undefined} the error message, when there is one.
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : undefined;
}

/** @returns {typeof import('react-native-image-picker') | null} */
function loadImagePicker() {
  if (_imagePickerCache !== undefined) return _imagePickerCache;
  try {
    _imagePickerCache = require('react-native-image-picker');
  } catch {
    _imagePickerCache = null;
  }
  return _imagePickerCache;
}

/** @returns {typeof import('@react-native-documents/picker') | null} */
function loadDocumentPicker() {
  if (_documentPickerCache !== undefined) return _documentPickerCache;
  try {
    _documentPickerCache = require('@react-native-documents/picker');
  } catch {
    _documentPickerCache = null;
  }
  return _documentPickerCache;
}

/** Reset the cached modules (tests only). */
export function _resetAttachmentPickerCache() {
  _imagePickerCache = undefined;
  _documentPickerCache = undefined;
}

/** Whether the photo/camera picker native module is linked. */
export function isImagePickerAvailable() {
  return Boolean(loadImagePicker());
}

/** Whether the file picker native module is linked. */
export function isDocumentPickerAvailable() {
  return Boolean(loadDocumentPicker());
}

/**
 * Normalise a `react-native-image-picker` asset into the shape
 * `attachmentUpload.js` expects.
 */
/**
 * @param {any} asset
 * @returns {{ uri: string, mimeType: string, sizeBytes: number, name?: string, width?: number, height?: number } | null}
 */
function normaliseImageAsset(asset) {
  if (!asset?.uri) return null;
  return {
    uri: asset.uri,
    mimeType: asset.type ?? 'image/jpeg',
    sizeBytes: asset.fileSize ?? 0,
    name: asset.fileName ?? undefined,
    width: asset.width ?? undefined,
    height: asset.height ?? undefined,
  };
}

/**
 * Launch the photo library picker.
 *
 * @returns {Promise<{ uri: string, mimeType: string, sizeBytes: number,
 *   name?: string, width?: number, height?: number } | null>} `null` when the
 *   module isn't linked, the user cancelled, or the picker errored.
 */
export async function pickPhoto() {
  const picker = loadImagePicker();
  if (!picker) return null;
  const result = await picker.launchImageLibrary({ mediaType: 'photo', quality: 0.8 });
  if (result.didCancel || result.errorCode) return null;
  return normaliseImageAsset(result.assets?.[0]);
}

/**
 * Launch the camera.
 *
 * @returns {Promise<{ uri: string, mimeType: string, sizeBytes: number,
 *   name?: string, width?: number, height?: number } | null>}
 */
export async function pickCameraPhoto() {
  const picker = loadImagePicker();
  if (!picker) return null;
  const result = await picker.launchCamera({
    mediaType: 'photo',
    quality: 0.8,
    saveToPhotos: true,
  });
  if (result.didCancel || result.errorCode) return null;
  return normaliseImageAsset(result.assets?.[0]);
}

/**
 * Launch the document (file) picker.
 *
 * @returns {Promise<{ uri: string, mimeType: string, sizeBytes: number,
 *   name?: string } | null>}
 */
export async function pickDocument() {
  const picker = loadDocumentPicker();
  if (!picker) return null;
  try {
    const [result] = await picker.pick({ type: [picker.types?.allFiles ?? '*/*'] });
    if (!result?.uri) return null;
    return {
      uri: result.uri,
      mimeType: result.type ?? 'application/octet-stream',
      sizeBytes: result.size ?? 0,
      name: result.name ?? undefined,
    };
  } catch (error) {
    // The picker libraries reject with a cancellation error when the user
    // backs out; that's expected and silent. Anything else is a genuine
    // picker failure (e.g. the native module errored) worth a log line, but
    // still resolves to "no attachment" — the composer just leaves the
    // attach sheet available to retry rather than surfacing a hard error.
    // `isErrorWithCode` accepts the expected code at runtime; the published
    // typings declare only the error parameter.
    const cancelled = /** @type {any} */ (picker).isErrorWithCode?.(error, 'OPERATION_CANCELED');
    if (!cancelled) {
      logWarn('[Attachments] document picker failed', { message: errorMessage(error) });
    }
    return null;
  }
}

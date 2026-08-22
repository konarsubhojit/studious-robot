/**
 * Tests the optional-native-module (try/catch require) pattern in
 * `attachmentPicker.js` for both branches: the picker libraries linked, and
 * not linked (fresh checkout / CI before a native rebuild).
 *
 * Each scenario uses `jest.isolateModules` + `jest.doMock` so the lazy-load
 * cache inside the module under test is rebuilt fresh against a chosen mock,
 * rather than depending on Jest's module-registry state across tests.
 */

function withImagePickerMock(/** @type {any} */ imagePickerMock: any, /** @type {any} */ run: any) {
  let result;
  jest.isolateModules(() => {
    if (imagePickerMock) {
      jest.doMock('react-native-image-picker', () => imagePickerMock, { virtual: true });
    } else {
      jest.doMock(
        'react-native-image-picker',
        () => {
          throw new Error('Native module RNImagePicker is not linked');
        },
        { virtual: true },
      );
    }
    result = run(require('../src/attachmentPicker'));
  });
  return result;
}

function withDocumentPickerMock(/** @type {any} */ documentPickerMock: any, /** @type {any} */ run: any) {
  let result;
  jest.isolateModules(() => {
    if (documentPickerMock) {
      jest.doMock('@react-native-documents/picker', () => documentPickerMock, { virtual: true });
    } else {
      jest.doMock(
        '@react-native-documents/picker',
        () => {
          throw new Error('Native module is not linked');
        },
        { virtual: true },
      );
    }
    result = run(require('../src/attachmentPicker'));
  });
  return result;
}

describe('attachmentPicker', () => {
  describe('when the native modules are not linked', () => {
    test('isImagePickerAvailable/pickPhoto/pickCameraPhoto degrade to null', async () => {
      await withImagePickerMock(null, async (/** @type {any} */ picker: any) => {
        expect(picker.isImagePickerAvailable()).toBe(false);
        await expect(picker.pickPhoto()).resolves.toBeNull();
        await expect(picker.pickCameraPhoto()).resolves.toBeNull();
      });
    });

    test('isDocumentPickerAvailable/pickDocument degrade to null', async () => {
      await withDocumentPickerMock(null, async (/** @type {any} */ picker: any) => {
        expect(picker.isDocumentPickerAvailable()).toBe(false);
        await expect(picker.pickDocument()).resolves.toBeNull();
      });
    });
  });

  describe('when the image picker is linked', () => {
    test('pickPhoto normalises the returned asset', async () => {
      const launchImageLibrary = jest.fn().mockResolvedValue({
        assets: [{ uri: 'file:///tmp/a.jpg', type: 'image/jpeg', fileSize: 2048, width: 100, height: 200 }],
      });
      await withImagePickerMock({ launchImageLibrary }, async (/** @type {any} */ picker: any) => {
        await expect(picker.pickPhoto()).resolves.toEqual({
          uri: 'file:///tmp/a.jpg',
          mimeType: 'image/jpeg',
          sizeBytes: 2048,
          name: undefined,
          width: 100,
          height: 200,
        });
        expect(launchImageLibrary).toHaveBeenCalledWith(
          expect.objectContaining({ mediaType: 'photo' }),
        );
      });
    });

    test('pickPhoto returns null when the user cancels', async () => {
      const launchImageLibrary = jest.fn().mockResolvedValue({ didCancel: true });
      await withImagePickerMock({ launchImageLibrary }, async (/** @type {any} */ picker: any) => {
        await expect(picker.pickPhoto()).resolves.toBeNull();
      });
    });

    test('pickCameraPhoto launches the camera and saves to the photo library', async () => {
      const launchCamera = jest.fn().mockResolvedValue({
        assets: [{ uri: 'file:///tmp/cam.jpg', type: 'image/jpeg', fileSize: 1024 }],
      });
      await withImagePickerMock({ launchCamera }, async (/** @type {any} */ picker: any) => {
        await expect(picker.pickCameraPhoto()).resolves.toEqual({
          uri: 'file:///tmp/cam.jpg',
          mimeType: 'image/jpeg',
          sizeBytes: 1024,
          name: undefined,
          width: undefined,
          height: undefined,
        });
        expect(launchCamera).toHaveBeenCalledWith(expect.objectContaining({ saveToPhotos: true }));
      });
    });
  });

  describe('when the document picker is linked', () => {
    test('pickDocument normalises the returned file', async () => {
      const pick = jest.fn().mockResolvedValue([
        { uri: 'file:///tmp/doc.pdf', type: 'application/pdf', size: 4096, name: 'doc.pdf' },
      ]);
      await withDocumentPickerMock({ pick, types: { allFiles: '*/*' } }, async (/** @type {any} */ picker: any) => {
        await expect(picker.pickDocument()).resolves.toEqual({
          uri: 'file:///tmp/doc.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 4096,
          name: 'doc.pdf',
        });
      });
    });

    test('pickDocument returns null when the user cancels', async () => {
      const pick = jest.fn().mockRejectedValue(new Error('cancelled'));
      const isErrorWithCode = jest.fn(() => true);
      await withDocumentPickerMock({ pick, isErrorWithCode }, async (/** @type {any} */ picker: any) => {
        await expect(picker.pickDocument()).resolves.toBeNull();
      });
    });
  });
});

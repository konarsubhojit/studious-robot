jest.mock('../src/attachmentPicker', () => ({ pickPhoto: jest.fn() }));
jest.mock('../src/permissions', () => ({ ensureAttachmentPermission: jest.fn() }));
jest.mock('../src/attachmentUpload', () => ({ putAttachment: jest.fn() }));
jest.mock('@bam.tech/react-native-image-resizer', () => ({
  __esModule: true,
  default: { createResizedImage: jest.fn() },
}));

import { uploadAvatar } from '../src/avatarUpload';
const { pickPhoto: mockPickPhoto } = require('../src/attachmentPicker');
const { ensureAttachmentPermission: mockPermission } = require('../src/permissions');
const { createResizedImage: mockResize } = require('@bam.tech/react-native-image-resizer').default;
const { putAttachment: mockPut } = require('../src/attachmentUpload');

const jsonResponse = (value: unknown, ok = true) => ({
  ok,
  json: async () => value,
}) as Response;

describe('uploadAvatar', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPermission.mockResolvedValue({ ok: true });
    mockPickPhoto.mockResolvedValue({ uri: 'file:///original.png' });
    mockResize.mockResolvedValue({
      uri: 'file:///resized.jpg',
      name: 'resized.jpg',
      size: 24_000,
      width: 512,
      height: 512,
    });
  });

  test('crops and downsizes before presigning, PUTs bytes, and publishes the avatar key', async () => {
    const requests: Array<{ url: string; options?: any }> = [];
    const authedFetch = jest.fn(async (build: (sessionId: string) => any) => {
      const request = build('session');
      requests.push(request);
      return request.url.endsWith('/avatar/presign')
        ? jsonResponse({ key: 'avatars/alice/new.jpg', uploadUrl: 'https://r2.example/put', headers: { 'Content-Type': 'image/jpeg' } })
        : jsonResponse({ avatarKey: 'avatars/alice/new.jpg' });
    });

    await expect(uploadAvatar({ authedFetch, signalingUrl: 'https://signal.example/' }))
      .resolves.toBe('avatars/alice/new.jpg');

    expect(mockPermission).toHaveBeenCalledWith('photo');
    expect(mockPickPhoto).toHaveBeenCalledWith({ maxWidth: 1024, maxHeight: 1024 });
    expect(mockResize).toHaveBeenCalledWith(
      'file:///original.png',
      512,
      512,
      'JPEG',
      82,
      0,
      undefined,
      false,
      { mode: 'cover', onlyScaleDown: true },
    );
    expect(requests[0]).toMatchObject({
      url: 'https://signal.example/avatar/presign',
      options: {
        method: 'POST',
        body: JSON.stringify({ mimeType: 'image/jpeg', sizeBytes: 24_000 }),
      },
    });
    expect(mockPut).toHaveBeenCalledWith({
      uploadUrl: 'https://r2.example/put',
      headers: { 'Content-Type': 'image/jpeg' },
      body: { uri: 'file:///resized.jpg', type: 'image/jpeg', name: 'resized.jpg' },
    });
    expect(requests[1]).toMatchObject({
      url: 'https://signal.example/avatar',
      options: { method: 'PUT', body: JSON.stringify({ key: 'avatars/alice/new.jpg' }) },
    });
  });

  test('does not contact the server when photo selection is cancelled', async () => {
    mockPickPhoto.mockResolvedValue(null);
    const authedFetch = jest.fn();

    await expect(uploadAvatar({ authedFetch, signalingUrl: 'https://signal.example' }))
      .resolves.toBeNull();
    expect(mockResize).not.toHaveBeenCalled();
    expect(authedFetch).not.toHaveBeenCalled();
  });
});

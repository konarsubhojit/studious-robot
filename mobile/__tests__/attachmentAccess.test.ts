import { AttachmentAccessError, resolveAttachmentDownloadUrl } from '../src/attachmentAccess';

function buildAuthedFetch(response: any) {
  return jest.fn((build: any) => {
    build('session-1');
    return Promise.resolve(response);
  });
}

describe('resolveAttachmentDownloadUrl', () => {
  test('requests the download endpoint with peerId and the stored url, authorized via Bearer', async () => {
    const authedFetch = buildAuthedFetch({
      ok: true,
      json: () => Promise.resolve({ downloadUrl: 'https://r2.example/signed?X-Amz-Signature=abc', expiresAt: '2024-01-01T00:00:01.000Z' }),
    });

    const result = await resolveAttachmentDownloadUrl({
      authedFetch,
      signalingUrl: 'https://signal.example',
      peerId: 'user-bob',
      url: 'https://cdn.example/chatblobs/conv-1/x.png',
    });

    expect(result).toBe('https://r2.example/signed?X-Amz-Signature=abc');
    const [buildRequest] = authedFetch.mock.calls[0];
    const request = buildRequest('session-1');
    const requestUrl = new URL(request.url);
    expect(requestUrl.origin + requestUrl.pathname).toBe('https://signal.example/attachments/download');
    expect(requestUrl.searchParams.get('peerId')).toBe('user-bob');
    expect(requestUrl.searchParams.get('url')).toBe('https://cdn.example/chatblobs/conv-1/x.png');
    expect(request.options.headers.authorization).toBe(['Bearer', 'session-1'].join(' '));
  });

  test('throws an AttachmentAccessError carrying the status on a non-2xx response', async () => {
    const authedFetch = buildAuthedFetch({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ error: 'forbidden' }),
    });

    await expect(
      resolveAttachmentDownloadUrl({
        authedFetch,
        signalingUrl: 'https://signal.example',
        peerId: 'user-bob',
        url: 'https://cdn.example/chatblobs/conv-1/x.png',
      }),
    ).rejects.toMatchObject({ status: 403, message: 'forbidden' });
  });

  test('throws when the server is unreachable', async () => {
    const authedFetch = jest.fn(() => Promise.resolve(null));

    await expect(
      resolveAttachmentDownloadUrl({
        authedFetch,
        signalingUrl: 'https://signal.example',
        peerId: 'user-bob',
        url: 'https://cdn.example/chatblobs/conv-1/x.png',
      }),
    ).rejects.toBeInstanceOf(AttachmentAccessError);
  });
});

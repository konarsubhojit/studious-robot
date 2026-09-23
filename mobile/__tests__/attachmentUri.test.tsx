import React from 'react';
import { Text } from 'react-native';
import renderer, { act } from 'react-test-renderer';

import {
  AttachmentUriProvider,
  isManagedAttachmentReference,
  useAttachmentUri,
} from '../src/attachmentUri';

function Probe({ reference }: { reference?: string | null; }) {
  const uri = useAttachmentUri(reference);
  return <Text testID="uri">{uri ?? 'none'}</Text>;
}

/** @returns the URI the probe currently renders. */
function renderedUri(tree: renderer.ReactTestRenderer): string {
  const node = tree.root.findAll((candidate: any) => candidate.props?.testID === 'uri')[0];
  return node.props.children as string;
}

async function renderProbe(element: React.ReactElement): Promise<renderer.ReactTestRenderer> {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(element);
  });
  return tree;
}

describe('isManagedAttachmentReference', () => {
  it('accepts an object key under the attachments prefix', () => {
    expect(isManagedAttachmentReference('chatblobs/alice_bob/photo.jpg')).toBe(true);
  });

  it('rejects fetchable URIs, local previews and anything outside the prefix', () => {
    expect(isManagedAttachmentReference('https://cdn.example/chatblobs/alice_bob/photo.jpg')).toBe(false);
    expect(isManagedAttachmentReference('file:///tmp/pending.jpg')).toBe(false);
    expect(isManagedAttachmentReference('content://media/1')).toBe(false);
    expect(isManagedAttachmentReference('private/secret.jpg')).toBe(false);
    expect(isManagedAttachmentReference('chatblobs/photo.jpg')).toBe(false);
    expect(isManagedAttachmentReference(null)).toBe(false);
  });
});

describe('useAttachmentUri', () => {
  it('exchanges a stored reference for an authorized link', async () => {
    const resolve = jest.fn().mockResolvedValue('https://signed.example/object?sig=1');
    const tree = await renderProbe(
      <AttachmentUriProvider resolve={resolve}>
        <Probe reference="chatblobs/alice_bob/photo.jpg" />
      </AttachmentUriProvider>,
    );

    expect(renderedUri(tree)).toBe('https://signed.example/object?sig=1');
    expect(resolve).toHaveBeenCalledWith('chatblobs/alice_bob/photo.jpg');
  });

  it('renders nothing rather than a stale link when authorization fails', async () => {
    const resolve = jest.fn().mockRejectedValue(Object.assign(new Error('refused'), { status: 403 }));
    const tree = await renderProbe(
      <AttachmentUriProvider resolve={resolve}>
        <Probe reference="chatblobs/alice_bob/photo.jpg" />
      </AttachmentUriProvider>,
    );

    expect(resolve).toHaveBeenCalled();
    expect(renderedUri(tree)).toBe('none');
  });

  it('uses a local preview verbatim, without asking the server', async () => {
    const resolve = jest.fn();
    const tree = await renderProbe(
      <AttachmentUriProvider resolve={resolve}>
        <Probe reference="file:///tmp/pending.jpg" />
      </AttachmentUriProvider>,
    );

    expect(renderedUri(tree)).toBe('file:///tmp/pending.jpg');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('yields nothing for a reference with no resolver in scope', async () => {
    const tree = await renderProbe(<Probe reference="chatblobs/alice_bob/photo.jpg" />);
    expect(renderedUri(tree)).toBe('none');
  });
});

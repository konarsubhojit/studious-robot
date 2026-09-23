import React, { createContext, useContext, useEffect, useState } from 'react';

import { ATTACHMENT_PATH_PREFIX } from '../../shared';
import { logWarn } from './appLogger';

/**
 * Display-time half of `GET /attachments/download`.
 *
 * The attachments bucket is private, so a message's `attachment.url` is an
 * opaque reference (the object key) rather than something a view can fetch.
 * Anything that renders bytes inline — an image bubble, the fullscreen media
 * viewer, a voice note — therefore exchanges the reference for a short-lived,
 * participant-authorized link first, exactly like an explicit download does.
 * Resolved links are held only for as long as the view that minted them is
 * mounted; they are never persisted, logged or handed to another view.
 *
 * A value that is not a managed reference (a local `file://`/`content://`
 * preview of something still uploading, or an already-fetchable link) is used
 * verbatim, so a screen rendered outside a provider keeps working.
 */
export type AttachmentUriResolver = (reference: string) => Promise<string>;

const AttachmentUriContext = createContext<AttachmentUriResolver | null>(null);

export function AttachmentUriProvider({
  resolve,
  children,
}: {
  resolve: AttachmentUriResolver | null;
  children: React.ReactNode;
}) {
  return <AttachmentUriContext.Provider value={resolve}>{children}</AttachmentUriContext.Provider>;
}

/** @returns the ambient resolver, or `null` outside a provider. */
export function useAttachmentUriResolver(): AttachmentUriResolver | null {
  return useContext(AttachmentUriContext);
}

/**
 * @returns whether `value` is a stored attachment reference, i.e. an object
 *   key under the attachments prefix rather than a fetchable URI.
 */
export function isManagedAttachmentReference(value: string | null | undefined): boolean {
  if (typeof value !== 'string' || !value) return false;
  const segments = value.split('/');
  return segments[0] === ATTACHMENT_PATH_PREFIX && segments.length >= 3;
}

/**
 * Resolve a stored attachment reference into something renderable.
 *
 * @param reference the message's `attachment.url` (or `thumbnailUrl`).
 * @returns the URI to render, or `undefined` while it is being resolved or
 *   when resolution failed.
 */
export function useAttachmentUri(reference: string | null | undefined): string | undefined {
  const resolve = useContext(AttachmentUriContext);
  const managed = isManagedAttachmentReference(reference);
  const [resolved, setResolved] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!managed || !resolve || typeof reference !== 'string') {
      setResolved(undefined);
      return undefined;
    }
    let cancelled = false;
    setResolved(undefined);
    resolve(reference)
      .then(uri => {
        if (!cancelled) setResolved(uri);
      })
      .catch(error => {
        if (cancelled) return;
        logWarn('[Attachments] could not resolve an attachment for display', {
          status: (error as { status?: number; })?.status,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [managed, reference, resolve]);

  if (!managed) return reference ?? undefined;
  return resolved;
}

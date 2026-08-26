/**
 * How the app describes the account you are signed in as.
 *
 * Settings knew the username and nothing else, so the one question the screen
 * could not answer was "which account is this?" — the thing a user needs when
 * they have both a Google and an email account and have forgotten which one
 * this device used.
 *
 * Kept out of `components/` and free of any Firebase import so it can be
 * asserted on without native modules, in the same spirit as `callUx.ts`.
 */

/**
 * Firebase provider ids, mapped to what a person would call them. Anything
 * unrecognised keeps its raw id rather than being flattened to "Other" — a
 * provider we have not met is still more useful named than hidden.
 */
const PROVIDER_LABELS: Record<string, string> = {
  'google.com': 'Google',
  'microsoft.com': 'Microsoft',
  password: 'Email',
  'apple.com': 'Apple',
  'github.com': 'GitHub',
  phone: 'Phone number',
};

/**
 * @param providerId Firebase `providerData[].providerId`.
 * @returns the provider's display name, or `null` when there is none to name.
 */
export function describeSignInProvider(providerId: string | null | undefined): string | null {
  const id = (providerId ?? '').trim();
  if (!id) return null;
  return PROVIDER_LABELS[id] ?? id;
}

/**
 * The identity card's second line: the email when there is one, otherwise the
 * provider that vouched for the account, otherwise a plain statement that the
 * identity is local to this device.
 *
 * Never returns an empty string: a blank line under the username reads as a
 * rendering fault rather than as "no email on file".
 */
export function describeAccount({
  email,
  providerId,
}: {
  email?: string | null;
  providerId?: string | null;
} = {}): string {
  const trimmedEmail = (email ?? '').trim();
  const provider = describeSignInProvider(providerId);
  if (trimmedEmail && provider) return `${trimmedEmail} · ${provider}`;
  if (trimmedEmail) return trimmedEmail;
  if (provider) return `Signed in with ${provider}`;
  return 'Signed in on this device';
}

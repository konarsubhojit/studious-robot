// @ts-check
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import useIdentity from '../../src/hooks/useIdentity';

jest.mock('../../src/appLogger', () => ({
  logInfo: jest.fn(),
}));

jest.mock('../../src/authService', () => ({
  isGoogleSignInConfigured: jest.fn(() => true),
  isMicrosoftSignInConfigured: jest.fn(() => true),
  observeAuthState: jest.fn(),
  registerWithEmail: jest.fn(),
  signInWithEmail: jest.fn(),
  signInWithGoogle: jest.fn(),
  signInWithMicrosoft: jest.fn(),
  signOut: jest.fn(),
}));

jest.mock('../../src/settingsStorage', () => ({
  loadIdentity: jest.fn(async () => ({ userId: '' })),
  saveIdentity: jest.fn(async () => true),
}));

const authService = require('../../src/authService');
const { loadIdentity, saveIdentity } = require('../../src/settingsStorage');

/** @type {any} */
let authListener;

function TestHook(/** @type {any} */ { resultRef, updateStatus }) {
  resultRef.current = useIdentity(updateStatus);
  return null;
}

function setup(updateStatus = jest.fn()) {
  /** @type {{ current: any }} */
  const resultRef = { current: null };
  act(() => {
    renderer.create(<TestHook resultRef={resultRef} updateStatus={updateStatus} />);
  });
  return { resultRef, updateStatus };
}

beforeEach(() => {
  jest.clearAllMocks();
  authListener = null;
  /** @type {jest.Mock} */ (authService.observeAuthState).mockImplementation(/** @type {any} */ listener => {
    authListener = listener;
    return jest.fn();
  });
  /** @type {jest.Mock} */ (loadIdentity).mockResolvedValue({ userId: '' });
  /** @type {jest.Mock} */ (saveIdentity).mockResolvedValue(true);
});

describe('useIdentity', () => {
  test('loads the stored username and waits for Firebase auth state', async () => {
    /** @type {jest.Mock} */ (loadIdentity).mockResolvedValue({ userId: 'alice' });
    const { resultRef } = setup();
    await act(async () => {
      await Promise.resolve();
    });
    expect(resultRef.current.isLoadingIdentity).toBe(true);

    act(() => authListener({ uid: 'firebase-alice' }));
    expect(resultRef.current.isLoadingIdentity).toBe(false);
    expect(resultRef.current.userId).toBe('alice');
    expect(resultRef.current.isRegistered).toBe(true);
  });

  test.each([
    ['email-register', 'registerWithEmail'],
    ['email-sign-in', 'signInWithEmail'],
    ['google', 'signInWithGoogle'],
    ['microsoft', 'signInWithMicrosoft'],
  ])('registerUser authenticates with %s and persists the username', async (method, functionName) => {
    const { resultRef } = setup();
    act(() => authListener({ uid: 'firebase-user' }));
    await act(async () => {
      await Promise.resolve();
      await resultRef.current.registerUser({
        userId: ' alice ',
        method,
        email: 'alice@example.com',
        password: 'secret12',
      });
    });

    expect(/** @type {Record<string, any>} */ (authService)[functionName]).toHaveBeenCalled();
    expect(saveIdentity).toHaveBeenCalledWith({ userId: 'alice' });
    expect(resultRef.current.userId).toBe('alice');
  });

  test('updateUserId rejects local renames for account-bound usernames', async () => {
    /** @type {jest.Mock} */ (loadIdentity).mockResolvedValue({ userId: 'alice' });
    const updateStatus = jest.fn();
    const { resultRef } = setup(updateStatus);
    act(() => authListener({ uid: 'firebase-user' }));
    await act(async () => {
      await Promise.resolve();
      await resultRef.current.updateUserId('bob');
    });
    expect(resultRef.current.userId).toBe('alice');
    expect(updateStatus).toHaveBeenCalledWith(expect.stringContaining('bound'), 'error');
  });

  test('unregisterUser signs out and clears the persisted username', async () => {
    /** @type {jest.Mock} */ (loadIdentity).mockResolvedValue({ userId: 'alice' });
    const { resultRef } = setup();
    act(() => authListener({ uid: 'firebase-user' }));
    await act(async () => {
      await Promise.resolve();
      await resultRef.current.unregisterUser();
    });
    expect(authService.signOut).toHaveBeenCalled();
    expect(saveIdentity).toHaveBeenCalledWith({ userId: '' });
    expect(resultRef.current.userId).toBe('');
  });

  test.each([
    ['auth/email-already-in-use', 'already in use', 'raw native error'],
    ['auth/weak-password', 'too weak', 'raw native error'],
    ['auth/invalid-email', 'valid email', 'raw native error'],
    ['auth/operation-not-allowed', 'disabled in Firebase Auth settings', 'raw native error'],
    [
      'auth/app-not-configured',
      'Firebase is not configured',
      'Firebase is not configured in this build. Add google-services.json (Android) or GoogleService-Info.plist (iOS).',
    ],
  ])('registerUser maps %s to a readable status message', async (code, expectedText, message) => {
    const updateStatus = jest.fn();
    /** @type {jest.Mock} */ (authService.registerWithEmail).mockRejectedValue({
      code,
      message,
    });
    const { resultRef } = setup(updateStatus);
    act(() => authListener({ uid: 'firebase-user' }));

    await act(async () => {
      await expect(
        resultRef.current.registerUser({
          userId: 'alice',
          method: 'email-register',
          email: 'alice@example.com',
          password: 'secret12',
        }),
      ).rejects.toBeTruthy();
    });

    expect(updateStatus).toHaveBeenCalledWith(expect.stringContaining(expectedText), 'error');
  });
});

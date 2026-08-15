import React from 'react';
import renderer, { act } from 'react-test-renderer';
import useIdentity from '../../src/hooks/useIdentity';

jest.mock('../../src/appLogger', () => ({
  logError: jest.fn(),
  logInfo: jest.fn(),
  logWarn: jest.fn(),
  logVerbose: jest.fn(),
}));

jest.mock('../../src/identityVerification', () => ({
  generateVerificationCode: jest.fn(() => 'ABCD-EFGH'),
  normalizeVerificationCode: jest.fn(code =>
    typeof code === 'string' ? code.trim().toUpperCase() : '',
  ),
}));

jest.mock('../../src/settingsStorage', () => ({
  loadIdentity: jest.fn(async () => ({ userId: '', verificationCode: '' })),
  saveIdentity: jest.fn(async () => true),
}));

const { generateVerificationCode, normalizeVerificationCode } = require('../../src/identityVerification');
const { loadIdentity, saveIdentity } = require('../../src/settingsStorage');

function TestHook({ resultRef, updateStatus }) {
  resultRef.current = useIdentity(updateStatus);
  return null;
}

function setup(updateStatus = jest.fn()) {
  const resultRef = { current: null };
  let tree;
  act(() => {
    tree = renderer.create(<TestHook resultRef={resultRef} updateStatus={updateStatus} />);
  });
  return { resultRef, updateStatus, tree };
}

beforeEach(() => {
  jest.clearAllMocks();
  generateVerificationCode.mockReturnValue('ABCD-EFGH');
  normalizeVerificationCode.mockImplementation(code =>
    typeof code === 'string' ? code.trim().toUpperCase() : '',
  );
  loadIdentity.mockResolvedValue({ userId: '', verificationCode: '' });
  saveIdentity.mockResolvedValue(true);
});

describe('useIdentity', () => {
  test('starts loading, then finishes with no stored identity', async () => {
    const { resultRef } = setup();
    expect(resultRef.current.isLoadingIdentity).toBe(true);
    await act(async () => {
      await Promise.resolve();
    });
    expect(resultRef.current.isLoadingIdentity).toBe(false);
    expect(resultRef.current.userId).toBe('');
    expect(resultRef.current.isRegistered).toBe(false);
  });

  test('loads a legacy identity without a verification code and generates + persists one', async () => {
    loadIdentity.mockResolvedValue({ userId: 'alice', verificationCode: '' });
    const updateStatus = jest.fn();
    const { resultRef } = setup(updateStatus);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(resultRef.current.userId).toBe('alice');
    expect(resultRef.current.verificationCode).toBe('ABCD-EFGH');
    expect(resultRef.current.pendingVerificationCode).toBe('ABCD-EFGH');
    expect(saveIdentity).toHaveBeenCalledWith({ userId: 'alice', verificationCode: 'ABCD-EFGH' });
    expect(updateStatus).toHaveBeenCalledWith(expect.stringContaining('recovery code'), 'info');
  });

  test('loads a stored identity that already has a verification code without regenerating', async () => {
    loadIdentity.mockResolvedValue({ userId: 'bob', verificationCode: 'wxyz-1234' });
    const { resultRef } = setup();

    await act(async () => {
      await Promise.resolve();
    });

    expect(resultRef.current.userId).toBe('bob');
    expect(resultRef.current.verificationCode).toBe('WXYZ-1234');
    expect(resultRef.current.pendingVerificationCode).toBe('');
    expect(saveIdentity).not.toHaveBeenCalled();
  });

  test('registerUser commits a new identity, persists it, and announces the code', async () => {
    const updateStatus = jest.fn();
    const { resultRef } = setup(updateStatus);
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      await resultRef.current.registerUser('newuser');
    });

    expect(resultRef.current.userId).toBe('newuser');
    expect(resultRef.current.verificationCode).toBe('ABCD-EFGH');
    expect(resultRef.current.pendingVerificationCode).toBe('ABCD-EFGH');
    expect(resultRef.current.isRegistered).toBe(true);
    expect(saveIdentity).toHaveBeenCalledWith({ userId: 'newuser', verificationCode: 'ABCD-EFGH' });
    expect(updateStatus).toHaveBeenCalledWith(expect.stringContaining('recovery code'), 'success');
  });

  test('registerUser reuses an existing verification code when provided', async () => {
    const { resultRef } = setup();
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      await resultRef.current.registerUser('newuser', 'existing-code');
    });

    expect(resultRef.current.verificationCode).toBe('EXISTING-CODE');
  });

  test('registerUser is a no-op for an empty/whitespace userId', async () => {
    const { resultRef } = setup();
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      await resultRef.current.registerUser('   ');
    });

    expect(resultRef.current.userId).toBe('');
    expect(saveIdentity).not.toHaveBeenCalled();
  });

  test('updateUserId renames the identity and persists a fresh verification code', async () => {
    loadIdentity.mockResolvedValue({ userId: 'alice', verificationCode: 'AAAA-1111' });
    const updateStatus = jest.fn();
    const { resultRef } = setup(updateStatus);
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      await resultRef.current.updateUserId('alice2');
    });

    expect(resultRef.current.userId).toBe('alice2');
    expect(resultRef.current.verificationCode).toBe('ABCD-EFGH');
    expect(updateStatus).toHaveBeenCalledWith(expect.stringContaining('Username updated'), 'success');
  });

  test('updateUserId is a no-op when renaming to the already-committed userId', async () => {
    loadIdentity.mockResolvedValue({ userId: 'alice', verificationCode: 'AAAA-1111' });
    const { resultRef } = setup();
    await act(async () => {
      await Promise.resolve();
    });
    saveIdentity.mockClear();

    await act(async () => {
      await resultRef.current.updateUserId('alice');
    });

    expect(saveIdentity).not.toHaveBeenCalled();
  });

  test('editUserId restores the committed verification code when re-typing the committed userId', async () => {
    loadIdentity.mockResolvedValue({ userId: 'alice', verificationCode: 'AAAA-1111' });
    const { resultRef } = setup();
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      resultRef.current.editUserId('someone-else');
    });
    expect(resultRef.current.userId).toBe('someone-else');
    expect(resultRef.current.verificationCode).toBe('');

    act(() => {
      resultRef.current.editUserId('alice');
    });
    expect(resultRef.current.verificationCode).toBe('AAAA-1111');
  });

  test('dismissVerificationCodeNotice clears the pending verification code', async () => {
    const { resultRef } = setup();
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await resultRef.current.registerUser('newuser');
    });
    expect(resultRef.current.pendingVerificationCode).toBe('ABCD-EFGH');

    act(() => {
      resultRef.current.dismissVerificationCodeNotice();
    });
    expect(resultRef.current.pendingVerificationCode).toBe('');
  });

  test('unregisterUser clears the identity and persists an empty identity', async () => {
    loadIdentity.mockResolvedValue({ userId: 'alice', verificationCode: 'AAAA-1111' });
    const { resultRef } = setup();
    await act(async () => {
      await Promise.resolve();
    });
    saveIdentity.mockClear();

    await act(async () => {
      await resultRef.current.unregisterUser();
    });

    expect(resultRef.current.userId).toBe('');
    expect(resultRef.current.verificationCode).toBe('');
    expect(resultRef.current.isRegistered).toBe(false);
    expect(saveIdentity).toHaveBeenCalledWith({ userId: '', verificationCode: '' });
  });
});

// @ts-check
describe('authService optional-provider loading', () => {
  const originalGoogleClientId = process.env.GOOGLE_WEB_CLIENT_ID;

  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    if (originalGoogleClientId === undefined) {
      delete process.env.GOOGLE_WEB_CLIENT_ID;
    } else {
      process.env.GOOGLE_WEB_CLIENT_ID = originalGoogleClientId;
    }
  });

  function mockFirebaseAuth() {
    const onAuthStateChanged = jest.fn(() => jest.fn());
    const createUserWithEmailAndPassword = jest.fn(async () => ({ user: { uid: 'u1' } }));
    const signInWithEmailAndPassword = jest.fn(async () => ({ user: { uid: 'u1' } }));
    const signInWithCredential = jest.fn(async () => ({ user: { uid: 'u1' } }));
    const signOut = jest.fn(async () => {});
    const currentUser = { getIdToken: jest.fn(async () => 'token-1') };
    const instance = {
      onAuthStateChanged,
      createUserWithEmailAndPassword,
      signInWithEmailAndPassword,
      signInWithCredential,
      signOut,
      currentUser,
    };
    const authMock = /** @type {jest.Mock & Record<string, any>} */ (jest.fn(() => instance));
    authMock.GoogleAuthProvider = { credential: jest.fn(() => ({ provider: 'google' })) };
    authMock.OAuthProvider = function OAuthProvider() {
      this.addScope = jest.fn();
    };
    jest.doMock('@react-native-firebase/auth', () => authMock);
    return { instance, authMock };
  }

  test('email/password helpers still work when Google native module is unavailable', async () => {
    const { instance } = mockFirebaseAuth();
    jest.doMock('@react-native-google-signin/google-signin', () => {
      throw new Error('missing module');
    });

    /** @type {any} */
    let authService;
    jest.isolateModules(() => {
      authService = require('../src/authService');
    });

    const unsubscribe = authService.observeAuthState(jest.fn());
    expect(typeof unsubscribe).toBe('function');

    await authService.registerWithEmail(' alice@example.com ', 'secret12');
    await authService.signInWithEmail(' alice@example.com ', 'secret12');
    await expect(authService.getIdToken()).resolves.toBe('token-1');
    await authService.signOut();

    expect(instance.createUserWithEmailAndPassword).toHaveBeenCalledWith('alice@example.com', 'secret12');
    expect(instance.signInWithEmailAndPassword).toHaveBeenCalledWith('alice@example.com', 'secret12');
    expect(instance.signOut).toHaveBeenCalled();
  });

  test('signInWithGoogle throws a clear message when Google Sign-In is unavailable', async () => {
    process.env.GOOGLE_WEB_CLIENT_ID = 'client-id';
    mockFirebaseAuth();
    jest.doMock('@react-native-google-signin/google-signin', () => {
      throw new Error('missing module');
    });

    /** @type {any} */
    let authService;
    jest.isolateModules(() => {
      authService = require('../src/authService');
    });

    await expect(authService.signInWithGoogle()).rejects.toThrow(
      'Google Sign-In is not available in this build',
    );
  });
});

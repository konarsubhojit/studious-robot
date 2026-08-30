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

  // Mirrors the modular @react-native-firebase/auth API (v22+): free functions
  // that take the Auth instance returned by `getAuth()` as their first argument.
  function mockFirebaseAuth() {
    const currentUser = { getIdToken: jest.fn(async () => 'token-1') };
    const instance = { currentUser };
    const api = {
      getAuth: jest.fn(() => instance),
      onAuthStateChanged: jest.fn(() => jest.fn()),
      createUserWithEmailAndPassword: jest.fn(async () => ({ user: { uid: 'u1' } })),
      signInWithEmailAndPassword: jest.fn(async () => ({ user: { uid: 'u1' } })),
      signInWithCredential: jest.fn(async () => ({ user: { uid: 'u1' } })),
      signInWithPopup: jest.fn(async () => ({ user: { uid: 'u1' } })),
      signOut: jest.fn(async () => {}),
      GoogleAuthProvider: { credential: jest.fn(() => ({ provider: 'google' })) },
      OAuthProvider: function OAuthProvider(this: any) {
        this.addScope = jest.fn();
      },
    };
    jest.doMock('@react-native-firebase/auth', () => api);
    return { instance, api };
  }

  test('email/password helpers still work when Google native module is unavailable', async () => {
    const { instance, api } = mockFirebaseAuth();
    jest.doMock('@react-native-google-signin/google-signin', () => {
      throw new Error('missing module');
    });

    let authService: any;
    jest.isolateModules(() => {
      authService = require('../src/authService');
    });

    const unsubscribe = authService.observeAuthState(jest.fn());
    expect(typeof unsubscribe).toBe('function');

    await authService.registerWithEmail(' alice@example.com ', 'secret12');
    await authService.signInWithEmail(' alice@example.com ', 'secret12');
    await expect(authService.getIdToken()).resolves.toBe('token-1');
    await authService.signOut();

    expect(api.createUserWithEmailAndPassword).toHaveBeenCalledWith(instance, 'alice@example.com', 'secret12');
    expect(api.signInWithEmailAndPassword).toHaveBeenCalledWith(instance, 'alice@example.com', 'secret12');
    expect(api.signOut).toHaveBeenCalledWith(instance);
  });

  test('signInWithGoogle throws a clear message when Google Sign-In is unavailable', async () => {
    process.env.GOOGLE_WEB_CLIENT_ID = 'client-id';
    mockFirebaseAuth();
    jest.doMock('@react-native-google-signin/google-signin', () => {
      throw new Error('missing module');
    });

    let authService: any;
    jest.isolateModules(() => {
      authService = require('../src/authService');
    });

    await expect(authService.signInWithGoogle()).rejects.toThrow(
      'Google Sign-In is not available in this build',
    );
  });
});

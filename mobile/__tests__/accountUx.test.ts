import { describeAccount, describeSignInProvider } from '../src/accountUx';

describe('describeSignInProvider', () => {
  test('names the providers the app offers', () => {
    expect(describeSignInProvider('google.com')).toBe('Google');
    expect(describeSignInProvider('microsoft.com')).toBe('Microsoft');
    expect(describeSignInProvider('password')).toBe('Email');
  });

  test('keeps an unrecognised provider id rather than hiding it', () => {
    // A provider enabled on the project before the app learns its label is
    // still more useful named than replaced with "Other".
    expect(describeSignInProvider('unknown-idp')).toBe('unknown-idp');
  });

  test('reports no provider at all as null, not as an empty label', () => {
    expect(describeSignInProvider(null)).toBeNull();
    expect(describeSignInProvider('   ')).toBeNull();
  });
});

describe('describeAccount', () => {
  test('names both the address and where it came from', () => {
    expect(describeAccount({ email: 'alice@example.com', providerId: 'google.com' })).toBe(
      'alice@example.com · Google',
    );
  });

  test('omits the provider when it is not known', () => {
    expect(describeAccount({ email: 'alice@example.com', providerId: null })).toBe(
      'alice@example.com',
    );
  });

  test('describes the provider alone when there is no address', () => {
    // Anonymous or phone-based sign-in carries no email; "Signed in with
    // Google" is still more useful than an empty row.
    expect(describeAccount({ email: null, providerId: 'google.com' })).toBe(
      'Signed in with Google',
    );
  });

  test('never renders an empty line', () => {
    expect(describeAccount({ email: null, providerId: null })).toBe('Signed in on this device');
    expect(describeAccount({ email: '  ', providerId: '  ' })).toBe('Signed in on this device');
  });
});

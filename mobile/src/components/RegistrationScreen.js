import { useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors, radius, spacing } from '../theme';
import AppButton from './AppButton';
import StatusBanner from './StatusBanner';

/**
 * First-launch registration screen.
 *
 * Asks the user to choose a username (userId) that identifies them on the
 * signaling server.  The userId is persisted in local storage so this screen
 * is only shown once; subsequent launches go directly to the Lobby.
 *
 * Purely presentational – all behaviour is supplied via props.
 *
 * @param {object}   props
 * @param {Function} props.onRegister - Called with the chosen authentication method and profile fields.
 * @param {boolean}  [props.isLoading] - Shows a loading state while the server is being reached.
 * @param {{ message: string, severity?: 'info'|'success'|'error' }} [props.status]
 */
export default function RegistrationScreen({ onRegister, isLoading = false, status }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const submit = method => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onRegister({
      userId: trimmed,
      method,
      email: email.trim(),
      password,
    });
  };
  const emailReady = name.trim() && email.trim() && password.length >= 6;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.content}>
        {/* ── Brand / hero section ───────────────────────────────────────── */}
        <View style={styles.hero}>
          <Text style={styles.logoGlyph}>📞</Text>
          <Text style={styles.appName}>WeTalk</Text>
          <Text style={styles.tagline}>Simple, warm one-to-one video calls</Text>
        </View>

        {/* ── Registration form ──────────────────────────────────────────── */}
        <View style={styles.form}>
          <StatusBanner status={status} />
          <Text style={styles.formTitle}>Choose your username</Text>
          <Text style={styles.formHint}>
            Other people will call you by this name.
            {'\n'}You can change it later in Settings.
          </Text>

          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="e.g. alice or alice-42"
            placeholderTextColor={colors.textSecondary}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
            onSubmitEditing={() => submit('email-register')}
            style={styles.input}
            accessibilityLabel="Your username"
            testID="registration-username-input"
          />

          <Text style={styles.optionalLabel}>Email</Text>
          <Text style={styles.optionalHint}>
            Register a new account or sign in to an existing one.
          </Text>
          <TextInput
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            placeholderTextColor={colors.textSecondary}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            style={styles.input}
            accessibilityLabel="Email address"
            testID="registration-email-input"
          />
          <TextInput
            value={password}
            onChangeText={setPassword}
            placeholder="Password (6+ characters)"
            placeholderTextColor={colors.textSecondary}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            returnKeyType="done"
            onSubmitEditing={() => submit('email-register')}
            style={styles.input}
            accessibilityLabel="Password"
            testID="registration-password-input"
          />

          <AppButton
            title={isLoading ? 'Setting up…' : 'Create account'}
            onPress={() => submit('email-register')}
            disabled={!emailReady || isLoading}
            accessibilityLabel="Create account"
            testID="registration-email-register"
          />
          <AppButton
            title="Sign in with email"
            onPress={() => submit('email-sign-in')}
            disabled={!emailReady || isLoading}
            testID="registration-email-sign-in"
          />
          <AppButton
            title="Continue with Google"
            onPress={() => submit('google')}
            disabled={!name.trim() || isLoading}
            testID="registration-google"
          />
          <AppButton
            title="Continue with Microsoft"
            onPress={() => submit('microsoft')}
            disabled={!name.trim() || isLoading}
            testID="registration-microsoft"
          />
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    flex: 1,
    paddingHorizontal: spacing.lg * 2,
    justifyContent: 'center',
    gap: spacing.lg * 2,
  },
  hero: {
    alignItems: 'center',
    gap: spacing.sm,
  },
  logoGlyph: {
    fontSize: 60,
  },
  appName: {
    fontSize: 36,
    fontWeight: '700',
    color: colors.textPrimary,
  },
  tagline: {
    color: colors.textSecondary,
    fontSize: 14,
    textAlign: 'center',
  },
  form: {
    gap: spacing.md,
  },
  formTitle: {
    color: colors.textPrimary,
    fontWeight: '700',
    fontSize: 18,
    textAlign: 'center',
  },
  formHint: {
    color: colors.textSecondary,
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 20,
  },
  optionalLabel: {
    color: colors.textPrimary,
    fontWeight: '600',
    fontSize: 14,
  },
  optionalHint: {
    color: colors.textSecondary,
    fontSize: 12,
    lineHeight: 18,
  },
  input: {
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    color: colors.textPrimary,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    fontSize: 16,
  },
});

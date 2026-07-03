import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
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
 * @param {Function} props.onRegister  - `(userId: string, verificationCode?: string) => void` called on submit.
 * @param {boolean}  [props.isLoading] - Shows a loading state while the server is being reached.
 * @param {{ message: string, severity?: 'info'|'success'|'error' }} [props.status]
 */
export default function RegistrationScreen({ onRegister, isLoading = false, status }) {
  const [name, setName] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');

  const handleSubmit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onRegister(trimmed, recoveryCode.trim());
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
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
            onSubmitEditing={handleSubmit}
            style={styles.input}
            accessibilityLabel="Your username"
            testID="registration-username-input"
          />

          <Text style={styles.optionalLabel}>Already have a recovery code?</Text>
          <Text style={styles.optionalHint}>
            If you already claimed this username on another device, enter its recovery code.
          </Text>
          <TextInput
            value={recoveryCode}
            onChangeText={(value) => setRecoveryCode(value.toUpperCase())}
            placeholder="Optional recovery code"
            placeholderTextColor={colors.textSecondary}
            autoCapitalize="characters"
            autoCorrect={false}
            returnKeyType="done"
            onSubmitEditing={handleSubmit}
            style={styles.input}
            accessibilityLabel="Recovery code"
            testID="registration-recovery-code-input"
          />

          <AppButton
            title={isLoading ? 'Setting up…' : 'Get Started'}
            onPress={handleSubmit}
            disabled={!name.trim() || isLoading}
            accessibilityLabel="Get started"
            testID="registration-submit"
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

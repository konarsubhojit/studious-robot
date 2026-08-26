import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { announceForAccessibility } from '../accessibilityAnnouncer';
import {
  AUTH_METHOD_COPY,
  REGISTRATION_STEP_TITLES,
  USERNAME_UNIQUENESS_NOTE,
  checkUsername,
  describeRegistrationStep,
  describeStepPosition,
  describeUsernameRule,
  stepForFailure,
} from '../registrationUx';
import { useTheme, useThemedStyles } from '../ThemeContext';
import { fontScaleCaps, radius, spacing, typography } from '../theme';
import AppButton from './AppButton';
import ErrorState from './ErrorState';
import { Icon, IconAction, Logotype, SectionHeader } from './primitives';
import StatusBanner from './StatusBanner';
import type { CallStatus } from './StatusBanner';
import type { AuthMethod, RegistrationStep, UsernameRuleState } from '../registrationUx';
import type { ThemeColors } from '../theme';

/**
 * First-launch registration, as two steps: choose how to sign in, then choose
 * the username that identifies you on the signaling server.
 *
 * It used to be one form asking for a username, an email, a password and a
 * provider at once, which put the one decision that cannot be undone — the
 * username, bound to the account by `resolveIdentityClaim` — in the middle of
 * the ones that can. Split, step 1 is a choice between four buttons and step 2
 * is a single field with the screen's whole attention on it.
 *
 * Purely presentational: all behaviour is supplied via props, and the props
 * contract is unchanged, so nothing about the split reaches `AppShell`.
 *
 * @param props.onRegister - Called with the chosen authentication method and
 *   profile fields, from step 2 only.
 * @param props.isLoading - Shows a loading state while the server is being reached.
 */
export type { AuthMethod };
export type RegistrationScreenProps = {
  onRegister: (registration: { userId: string; method: AuthMethod; email?: string; password?: string; }) => void;
  isLoading?: boolean;
  status?: CallStatus;
  isGoogleSignInAvailable?: boolean;
  isMicrosoftSignInAvailable?: boolean;
};

export default function RegistrationScreen({
  onRegister,
  isLoading = false,
  status,
  isGoogleSignInAvailable = true,
  isMicrosoftSignInAvailable = true,
}: RegistrationScreenProps) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // The chosen method *is* the step: step 2 exists to complete a choice, so it
  // cannot be reached without one, and going back is simply un-choosing.
  // Nothing typed is cleared on the way, so the two steps behave like one form
  // the user can walk in either direction.
  const [chosenMethod, setChosenMethod] = useState((null as AuthMethod | null));
  // Remembered so a failed attempt can be retried from the error state
  // without the user having to work out which button they pressed.
  const [lastMethod, setLastMethod] = useState((null as AuthMethod | null));

  const step: RegistrationStep = chosenMethod ? 'username' : 'method';
  const username = checkUsername(name);
  const emailReady = Boolean(email.trim()) && password.length >= 6;
  const hasError = status?.severity === 'error' && Boolean(status?.message);
  const failureMessage = hasError ? status.message : '';
  // Retrying with a username that cannot be sent is a button that does
  // nothing, so the affordance appears only when it can actually act.
  const canRetry = Boolean(lastMethod) && !isLoading && username.isValid;

  // A failure has to leave the user on the step that owns it: a taken username
  // is fixed in step 2, a rejected email or password in step 1. Keyed on the
  // message so a re-render — or the user deliberately stepping away while the
  // error is still on screen — does not drag them back.
  const routedFailureRef = useRef((null as string | null));
  useEffect(() => {
    if (!failureMessage) {
      routedFailureRef.current = null;
      return;
    }
    if (routedFailureRef.current === failureMessage) return;
    routedFailureRef.current = failureMessage;
    const target = stepForFailure(failureMessage);
    if (target === 'method') setChosenMethod(null);
    else if (target === 'username' && lastMethod) setChosenMethod(lastMethod);
  }, [failureMessage, lastMethod]);

  // Swapping the form's contents is not a navigation event, so nothing else
  // tells a screen reader that the screen it has just read is gone. The first
  // render is not announced: arriving at step 1 is not a change.
  const announcedStepRef = useRef(step);
  useEffect(() => {
    if (announcedStepRef.current === step) return;
    announcedStepRef.current = step;
    announceForAccessibility(describeRegistrationStep(step));
  }, [step]);

  /** Step 1: record the choice and move on. Nothing is sent until step 2. */
  const chooseMethod = (method: AuthMethod) => setChosenMethod(method);

  /** @param method - The step-1 choice being completed, or retried. */
  const submit = (method: AuthMethod) => {
    if (!username.isValid) return;
    setLastMethod(method);
    onRegister({
      userId: username.value,
      method,
      email: email.trim(),
      password,
    });
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.content}>
        {/* ── Brand / hero section ───────────────────────────────────────── */}
        <View style={styles.hero}>
          <Logotype testID="registration-logo" />
          <Text style={styles.tagline}>Simple, warm one-to-one video calls</Text>
        </View>

        {/* ── Registration form ──────────────────────────────────────────── */}
        <View style={styles.form}>
          {hasError ? (
            <ErrorState
              title="Couldn't complete sign-in"
              description={status.message}
              actionLabel="Try again"
              actionHint="Retries the last sign-in attempt"
              onAction={canRetry && lastMethod ? () => submit(lastMethod) : undefined}
              testID="registration-error"
            />
          ) : (
            <StatusBanner status={status} />
          )}

          {/* The way back sits with the heading, where the user is already
              looking, rather than below the primary action. */}
          <View style={styles.stepHeader}>
            {chosenMethod ? (
              <IconAction
                icon="back"
                variant="plain"
                accessibilityLabel="Back"
                accessibilityHint="Returns to the sign-in choices, keeping what you have typed"
                onPress={() => setChosenMethod(null)}
                disabled={isLoading}
                testID="registration-back"
              />
            ) : null}
            <View style={styles.stepHeading}>
              <Text style={styles.stepPosition} maxFontSizeMultiplier={fontScaleCaps.meta}>
                {describeStepPosition(step)}
              </Text>
              <Text style={styles.formTitle} accessibilityRole="header">
                {REGISTRATION_STEP_TITLES[step]}
              </Text>
            </View>
          </View>

          {chosenMethod ? (
            /* ── Step 2: choose a username ─────────────────────────────── */
            <View style={styles.step}>
              <Text style={styles.formHint}>
                {AUTH_METHOD_COPY[chosenMethod].chosenLabel}.
                {'\n'}Other people will call you by this name, and it stays bound to your account.
              </Text>

              <TextInput
                value={name}
                onChangeText={setName}
                placeholder="e.g. alice or alice-42"
                placeholderTextColor={colors.textSecondary}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="done"
                onSubmitEditing={() => submit(chosenMethod)}
                style={styles.input}
                accessibilityLabel="Your username"
                accessibilityHint="Other people will call you by this name"
                testID="registration-username-input"
              />

              <View style={styles.rules} testID="registration-username-rules">
                {username.rules.map(rule => (
                  <View
                    key={rule.id}
                    style={styles.rule}
                    accessible
                    accessibilityLabel={describeUsernameRule(rule)}
                    testID={`registration-username-rule-${rule.id}`}>
                    <Icon
                      name={rule.state === 'met' ? 'check' : 'presenceOffline'}
                      size={RULE_ICON_SIZE}
                      color={ruleColor(colors, rule.state)}
                    />
                    <Text style={[styles.ruleLabel, { color: ruleColor(colors, rule.state) }]}>
                      {rule.label}
                    </Text>
                  </View>
                ))}
              </View>

              {/* One live sentence, rather than a live region over the whole
                  checklist, which would re-read all three rules per keystroke. */}
              <Text
                style={styles.summary}
                accessibilityLiveRegion="polite"
                testID="registration-username-summary">
                {username.summary}
              </Text>
              <Text style={styles.note} testID="registration-username-note">
                {USERNAME_UNIQUENESS_NOTE}
              </Text>

              <AppButton
                title={isLoading ? 'Setting up…' : AUTH_METHOD_COPY[chosenMethod].submitLabel}
                onPress={() => submit(chosenMethod)}
                disabled={!username.isValid || isLoading}
                accessibilityHint="Sends this username with the sign-in method you chose"
                testID="registration-submit"
              />
            </View>
          ) : (
            /* ── Step 1: choose how to sign in ─────────────────────────── */
            <View style={styles.step}>
              <AppButton
                title={isGoogleSignInAvailable ? 'Continue with Google' : 'Google unavailable'}
                onPress={() => chooseMethod('google')}
                disabled={!isGoogleSignInAvailable || isLoading}
                accessibilityHint={
                  isGoogleSignInAvailable
                    ? 'Goes to step 2 to choose your username'
                    : 'Google sign-in is not configured in this build'
                }
                testID="registration-google"
              />
              <AppButton
                title={
                  isMicrosoftSignInAvailable ? 'Continue with Microsoft' : 'Microsoft unavailable'
                }
                onPress={() => chooseMethod('microsoft')}
                disabled={!isMicrosoftSignInAvailable || isLoading}
                accessibilityHint={
                  isMicrosoftSignInAvailable
                    ? 'Goes to step 2 to choose your username'
                    : 'Microsoft sign-in is not configured in this build'
                }
                testID="registration-microsoft"
              />

              <SectionHeader title="Or use an email address" variant="section" />
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
                textContentType="emailAddress"
                autoComplete="email"
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
                textContentType="password"
                autoComplete="password"
                returnKeyType="done"
                onSubmitEditing={() => {
                  if (emailReady) chooseMethod('email-register');
                }}
                style={styles.input}
                accessibilityLabel="Password"
                accessibilityHint="At least 6 characters"
                testID="registration-password-input"
              />

              {/* No 'Setting up…' title on these: they advance a step, they no
                  longer reach the network. That title belongs to step 2. */}
              <AppButton
                title="Create account"
                onPress={() => chooseMethod('email-register')}
                disabled={!emailReady || isLoading}
                accessibilityLabel="Create account"
                accessibilityHint="Goes to step 2 to choose the username for the new account"
                testID="registration-email-register"
              />
              <AppButton
                title="Sign in with email"
                onPress={() => chooseMethod('email-sign-in')}
                disabled={!emailReady || isLoading}
                accessibilityHint="Goes to step 2 to confirm the username on your existing account"
                testID="registration-email-sign-in"
              />
            </View>
          )}
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

/** Tick / open-circle glyph beside a rule, sized to the caption it labels. */
const RULE_ICON_SIZE = 16;

/**
 * Colour of a checklist row. The glyph only separates met from not-met; colour
 * is what separates "not yet" from "no", so an untouched field reads as
 * neutral rather than as three failures.
 *
 * @param colors - Active palette.
 * @param state - Rule state from `checkUsername`.
 */
function ruleColor(colors: ThemeColors, state: UsernameRuleState): string {
  if (state === 'met') return colors.positive;
  return state === 'unmet' ? colors.negative : colors.onSurfaceVariant;
}

/** @param colors */
const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.background,
    },
    content: {
      flex: 1,
      paddingHorizontal: spacing['2xl'],
      justifyContent: 'center',
      gap: spacing['2xl'],
    },
    hero: {
      alignItems: 'center',
      gap: spacing.sm,
    },
    tagline: {
      ...typography.body,
      color: colors.textSecondary,
      textAlign: 'center',
    },
    form: {
      gap: spacing.md,
    },
    stepHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
    },
    stepHeading: {
      flex: 1,
    },
    stepPosition: {
      ...typography.caption,
      color: colors.textSecondary,
    },
    formTitle: {
      ...typography.headline,
      color: colors.textPrimary,
    },
    formHint: {
      ...typography.body,
      color: colors.textSecondary,
    },
    step: {
      gap: spacing.md,
    },
    optionalHint: {
      ...typography.caption,
      color: colors.textSecondary,
    },
    rules: {
      gap: spacing.xs,
    },
    rule: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    ruleLabel: {
      ...typography.caption,
      flex: 1,
    },
    summary: {
      ...typography.body,
      color: colors.textPrimary,
    },
    note: {
      ...typography.caption,
      color: colors.textMuted,
    },
    input: {
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      color: colors.textPrimary,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
      fontSize: 16,
    },
  });

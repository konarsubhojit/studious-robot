import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { colors, radius, spacing, typography } from '../theme';
import { ICONS, loadVectorIcons } from '../vectorIcons';
import AppButton from './AppButton';
import StatusBanner from './StatusBanner';

/**
 * Small uppercase group label used to introduce each settings section,
 * optionally preceded by a semantic icon from `vectorIcons.js` so section
 * headers read consistently with the rest of the app's icon usage.
 *
 * @param {object} props
 * @param {string} [props.icon] - Semantic icon key from ICONS map.
 * @param {import('react').ReactNode} props.children
 */
function SectionLabel({ icon, children }) {
  const MCIcon = loadVectorIcons();
  const iconDef = icon ? ICONS[icon] : null;
  return (
    <View style={styles.sectionLabelRow}>
      {iconDef && MCIcon ? (
        <MCIcon name={iconDef.icon} size={14} color={colors.textSecondary} />
      ) : iconDef ? (
        <Text style={styles.sectionLabelEmoji}>{iconDef.emoji}</Text>
      ) : null}
      <Text style={styles.sectionTitle}>{children}</Text>
    </View>
  );
}

/**
 * Account & connection settings.
 *
 * Lets a registered user change the username other people call them by, point
 * the app at a different signaling server, and sign out (which clears the
 * persisted identity and returns to the RegistrationScreen).
 *
 * Purely presentational – all behaviour is supplied via props.  Local input
 * state is committed only when the user presses the matching "Save" button so
 * an in-progress edit never mutates the live identity.
 *
 * @param {object}   props
 * @param {string}   props.userId               - Current username.
 * @param {Function} props.onSaveUserId          - `(userId: string) => void` persist a new username.
 * @param {string}   props.signalingUrl          - Current signaling server URL.
 * @param {Function} props.onSaveSignalingUrl    - `(url: string) => void` persist a new URL.
 * @param {Function} props.onSignOut             - Clear the identity and return to registration.
 * @param {Function} props.onClose               - Dismiss the screen (back to Lobby).
 * @param {Function} [props.onExportLogs]        - Optional: export diagnostic logs.
 * @param {boolean}  [props.developerModeEnabled] - Whether the legacy room-join developer tools are shown in the Lobby.
 * @param {Function} [props.onToggleDeveloperMode] - Toggle developer mode on/off.
 * @param {{ message: string, severity?: 'info'|'success'|'error' }} [props.status]
 */
export default function SettingsScreen({
  userId,
  onSaveUserId,
  signalingUrl,
  onSaveSignalingUrl,
  onSignOut,
  onClose,
  onExportLogs,
  developerModeEnabled,
  onToggleDeveloperMode,
  status,
}) {
  const [name, setName] = useState(userId ?? '');
  const [url, setUrl] = useState(signalingUrl ?? '');

  const trimmedName = name.trim();
  const trimmedUrl = url.trim();
  const nameDirty = trimmedName.length > 0 && trimmedName !== (userId ?? '').trim();
  const urlDirty = trimmedUrl.length > 0 && trimmedUrl !== (signalingUrl ?? '').trim();

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <StatusBanner status={status} style={styles.statusBanner} />

        {/* ── Header ──────────────────────────────────────────────────────── */}
        <View style={styles.headerRow}>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Back"
            testID="settings-back"
            style={styles.backButton}>
            <Text style={styles.backIcon}>‹</Text>
          </Pressable>
          <Text style={styles.title}>Settings</Text>
        </View>

        {/* ── Username ────────────────────────────────────────────────────── */}
        <SectionLabel icon="settingsUsername">Username</SectionLabel>
        <Text style={styles.hint}>Other people will call you by this name.</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Your username"
          placeholderTextColor={colors.textSecondary}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
          accessibilityLabel="Username"
          testID="settings-username-input"
        />
        <AppButton
          title="Save username"
          onPress={() => onSaveUserId(trimmedName)}
          disabled={!nameDirty}
          testID="settings-save-username"
          style={styles.saveButton}
        />

        {/* ── Signaling server ────────────────────────────────────────────── */}
        <SectionLabel icon="settingsServer">Signaling server</SectionLabel>
        <Text style={styles.hint}>The server that routes your calls.</Text>
        <TextInput
          value={url}
          onChangeText={setUrl}
          placeholder="https://signaling.example.com"
          placeholderTextColor={colors.textSecondary}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          style={styles.input}
          accessibilityLabel="Signaling server URL"
          testID="settings-signaling-input"
        />
        <AppButton
          title="Save server"
          onPress={() => onSaveSignalingUrl(trimmedUrl)}
          disabled={!urlDirty}
          testID="settings-save-signaling"
          style={styles.saveButton}
        />

        {/* ── Developer ───────────────────────────────────────────────────── */}
        {onToggleDeveloperMode ? (
          <>
            <SectionLabel icon="settingsDeveloper">Developer</SectionLabel>
            <Pressable
              onPress={onToggleDeveloperMode}
              accessibilityRole="switch"
              accessibilityLabel="Developer mode"
              accessibilityHint="Shows the legacy room-join tools in the lobby"
              accessibilityState={{ checked: Boolean(developerModeEnabled) }}
              testID="settings-developer-mode"
              style={({ pressed }) => [styles.toggleRow, pressed && styles.pressed]}>
              <View style={styles.toggleTextWrap}>
                <Text style={styles.toggleLabel}>Developer mode</Text>
                <Text style={styles.hint}>
                  Show the legacy Join Room tools (signaling URL, room ID) in the lobby.
                </Text>
              </View>
              <Text style={styles.toggleValue}>{developerModeEnabled ? 'On' : 'Off'}</Text>
            </Pressable>
          </>
        ) : null}

        {/* ── Account actions ─────────────────────────────────────────────── */}
        <SectionLabel icon="settingsAccountSection">Account</SectionLabel>
        {onExportLogs ? (
          <AppButton
            title="Export logs"
            onPress={onExportLogs}
            testID="settings-export-logs"
            style={styles.saveButton}
          />
        ) : null}
        <Pressable
          onPress={onSignOut}
          accessibilityRole="button"
          accessibilityLabel="Sign out"
          testID="settings-sign-out"
          style={({ pressed }) => [styles.signOutButton, pressed && styles.pressed]}>
          <Text style={styles.signOutText}>Sign out</Text>
        </Pressable>
        <Text style={styles.signOutHint}>
          Signing out clears your identity on this device and stops incoming-call notifications
          until you register again.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: {
    padding: spacing.lg,
    paddingBottom: spacing.xl,
  },
  statusBanner: {
    marginBottom: spacing.sm,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.lg,
  },
  backButton: {
    height: 36,
    width: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceControl,
  },
  backIcon: {
    color: colors.textPrimary,
    fontSize: 26,
    lineHeight: 28,
    marginTop: -2,
  },
  title: {
    ...typography.title,
    color: colors.textPrimary,
  },
  sectionLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: spacing.lg,
    marginBottom: spacing.xs,
  },
  sectionLabelEmoji: {
    fontSize: 12,
    lineHeight: 14,
  },
  sectionTitle: {
    ...typography.groupLabel,
    color: colors.textSecondary,
  },
  hint: {
    ...typography.hint,
    color: colors.textSecondary,
    marginBottom: spacing.sm,
  },
  input: {
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    color: colors.textPrimary,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    marginBottom: spacing.sm,
  },
  saveButton: {
    marginBottom: spacing.sm,
  },
  signOutButton: {
    minHeight: 44,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.danger,
    backgroundColor: 'transparent',
    marginTop: spacing.xs,
  },
  signOutText: {
    color: colors.danger,
    fontWeight: '700',
  },
  signOutHint: {
    color: colors.textSecondary,
    fontSize: 12,
    marginTop: spacing.sm,
  },
  toggleRow: {
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  toggleTextWrap: {
    flexShrink: 1,
  },
  toggleLabel: {
    color: colors.textPrimary,
    fontWeight: '600',
    marginBottom: 2,
  },
  toggleValue: {
    color: colors.accentValue,
    fontWeight: '700',
    minWidth: 28,
    textAlign: 'right',
  },
  pressed: {
    opacity: 0.78,
  },
});

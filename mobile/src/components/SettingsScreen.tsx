import { memo, useEffect, useState } from 'react';
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
import { describeAccount } from '../accountUx';
import { APP_VERSION, describePlatform } from '../appInfo';
import { THIRD_PARTY_LICENSES, summarizeLicenses } from '../licenses';
import { EMPTY_STORAGE_USAGE, formatBytes } from '../storageUsage';
import { useTheme, useThemedStyles } from '../ThemeContext';
import { radius, sizes, spacing, THEME_MODES, touchSlop, typography } from '../theme';
import { ICE_TRANSPORT_POLICIES, normalizeIceTransportPolicy } from '../webrtcConfig';
import AppButton from './AppButton';
import { Avatar, Divider, IconAction, ListItem, SectionHeader, Sheet, Switch } from './primitives';
import StatusBanner from './StatusBanner';
import type { CallStatus } from './StatusBanner';
import type { StorageUsage } from '../storageUsage';
import type { ThemeColors } from '../theme';

const APPEARANCE_OPTIONS = [
  { mode: THEME_MODES.SYSTEM, label: 'System', testID: 'settings-theme-system' },
  { mode: THEME_MODES.LIGHT, label: 'Light', testID: 'settings-theme-light' },
  { mode: THEME_MODES.DARK, label: 'Dark', testID: 'settings-theme-dark' },
];

const ICE_TRANSPORT_POLICY_OPTIONS = [
  { policy: ICE_TRANSPORT_POLICIES.ALL, label: 'Default', testID: 'settings-ice-policy-all' },
  { policy: ICE_TRANSPORT_POLICIES.RELAY, label: 'Force TURN', testID: 'settings-ice-policy-relay' },
];

export type SettingsScreenProps = {
  /** Current username. */
  userId: string;
  /** Email of the signed-in account, when the provider supplied one. */
  accountEmail?: string | null;
  /** Firebase provider id the account signed in with, e.g. `google.com`. */
  accountProviderId?: string | null;
  /** Current signaling server URL. */
  signalingUrl: string;
  /** Persist a new URL. */
  onSaveSignalingUrl: (url: string) => void;
  /** Clear the identity and return to registration. */
  onSignOut: () => void;
  /** Dismiss the screen and return to the tabs. */
  onClose: () => void;
  /** Optional: export diagnostic logs. */
  onExportLogs?: () => void;
  /** What the app is storing on this device. */
  storageUsage?: StorageUsage;
  /** Measure (or re-measure) on-device usage; called when the screen appears. */
  onRefreshStorage?: () => void;
  /** Delete the cached media the app can re-fetch. */
  onClearCachedMedia?: () => void;
  /** A measurement is in flight. */
  isMeasuringStorage?: boolean;
  /** A clear is in flight. */
  isClearingMedia?: boolean;
  /** Whether the extra diagnostic tools are shown. */
  developerModeEnabled?: boolean;
  /** Toggle developer mode on/off. */
  onToggleDeveloperMode?: () => void;
  /** Route call audio to the loudspeaker as soon as a call connects. */
  speakerDefaultEnabled?: boolean;
  /** Toggle speaker-by-default. */
  onToggleSpeakerDefault?: () => void;
  /** Let the app raise camera brightness in poor light. */
  autoLightingEnabled?: boolean;
  /** Toggle automatic camera lighting. */
  onToggleAutoLighting?: () => void;
  /** Current WebRTC ICE transport policy. */
  iceTransportPolicy?: string;
  /** Persist the WebRTC ICE transport policy used for new calls. */
  onChangeIceTransportPolicy?: (policy: string) => void;
  /** Master switch for chat-message notifications. */
  messageNotificationsEnabled?: boolean;
  /** Turn chat-message notifications on or off. */
  onToggleMessageNotifications?: (next: boolean) => void;
  /** People whose message notifications are silenced, newest first. */
  mutedPeers?: string[];
  /** Unmute one person, in place. */
  onUnmutePeer?: (peerId: string) => void;
  /** People blocked server-side. */
  blockedUsers?: string[];
  /** Unblock one person, in place. */
  onUnblockUser?: (peerId: string) => void;
  /** Open the person hub; every person-shaped row routes there. */
  onOpenProfile?: (peerId: string) => void;
  status?: CallStatus;
};

/**
 * Account, notification, privacy, storage and connection settings.
 *
 * Grouped rather than stacked: the screen used to be a single column of bare
 * "TextInput + Save" pairs and toggles in the order they happened to be added.
 * It now opens with who you are signed in as, then **Account · Notifications ·
 * Calls & media · Appearance · Privacy · Storage & data · Advanced · About**,
 * with sign-out last and separated from the rest so a destructive action is
 * never adjacent to a routine one.
 *
 * The Notifications and Privacy groups are the two lists the app previously had
 * no way to inspect at all: muting and blocking could be applied from a person's
 * hub, but nothing anywhere showed *who* was muted or blocked, which made both
 * effectively irreversible for anyone who forgot.
 *
 * Two decisions worth keeping:
 *
 * - **The username is shown, not edited.** It is claimed by the account on the
 *   signaling server (`POST /session` answers 409 for a username bound
 *   elsewhere), and `useIdentity.updateUserId` accordingly refuses every change
 *   — so an editor here could only ever produce an error. Stating the rule is
 *   honest; offering a control that cannot succeed is not.
 * - **The remaining editable value opens a focused editor.** An inline
 *   `TextInput` in a settings list invites accidental edits and gives a long
 *   value (a server URL) a two-character-wide viewport; a sheet gives it the
 *   whole width and an explicit commit.
 *
 * Purely presentational – all behaviour is supplied via props.  Editor state is
 * committed only when the user presses "Save" so an in-progress edit never
 * mutates the live configuration.
 */
function SettingsScreen({
  userId,
  accountEmail,
  accountProviderId,
  signalingUrl,
  onSaveSignalingUrl,
  onSignOut,
  onClose,
  onExportLogs,
  storageUsage = EMPTY_STORAGE_USAGE,
  onRefreshStorage,
  onClearCachedMedia,
  isMeasuringStorage = false,
  isClearingMedia = false,
  developerModeEnabled,
  onToggleDeveloperMode,
  speakerDefaultEnabled,
  onToggleSpeakerDefault,
  autoLightingEnabled,
  onToggleAutoLighting,
  iceTransportPolicy = ICE_TRANSPORT_POLICIES.ALL,
  onChangeIceTransportPolicy,
  messageNotificationsEnabled = true,
  onToggleMessageNotifications,
  mutedPeers = [],
  onUnmutePeer,
  blockedUsers = [],
  onUnblockUser,
  onOpenProfile,
  status,
}: SettingsScreenProps) {
  const { colors, mode: themeMode, setMode: setThemeMode } = useTheme();
  const styles = useThemedStyles(createStyles);

  const [url, setUrl] = useState(signalingUrl ?? '');
  const [isEditingSignalingUrl, setIsEditingSignalingUrl] = useState(false);
  const [isShowingLicenses, setIsShowingLicenses] = useState(false);

  // Measured when the screen appears rather than continuously: nothing outside
  // this screen reads the number, and the crawl is not free.
  useEffect(() => {
    onRefreshStorage?.();
  }, [onRefreshStorage]);

  const activeIceTransportPolicy = normalizeIceTransportPolicy(iceTransportPolicy);
  const trimmedUrl = url.trim();
  const urlDirty = trimmedUrl.length > 0 && trimmedUrl !== (signalingUrl ?? '').trim();
  const accountLine = describeAccount({ email: accountEmail, providerId: accountProviderId });

  const openSignalingEditor = () => {
    // Seeded from the live value on every open, so a cancelled edit cannot
    // survive as a stale draft the next time the sheet is opened.
    setUrl(signalingUrl ?? '');
    setIsEditingSignalingUrl(true);
  };

  const saveSignalingUrl = () => {
    onSaveSignalingUrl(trimmedUrl);
    setIsEditingSignalingUrl(false);
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <StatusBanner status={status} style={styles.statusBanner} />

        {/* ── Header ──────────────────────────────────────────────────────── */}
        <View style={styles.headerRow}>
          <IconAction
            icon="back"
            accessibilityLabel="Back"
            accessibilityHint="Returns to the previous screen"
            onPress={onClose}
            testID="settings-back"
          />
          <Text style={styles.title} accessibilityRole="header">
            Settings
          </Text>
        </View>

        {/* ── Who you are signed in as ────────────────────────────────────── */}
        <View style={styles.identity} testID="settings-identity">
          <Avatar id={userId} size="lg" />
          <View style={styles.identityText}>
            <Text style={styles.identityName} numberOfLines={1}>
              {userId || 'Not signed in'}
            </Text>
            <Text style={styles.identityAccount} numberOfLines={2} testID="settings-account">
              {accountLine}
            </Text>
          </View>
        </View>

        {/* ── Account ─────────────────────────────────────────────────────── */}
        <SectionHeader title="Account" icon="settingsUsername" />
        <ListItem
          title="Username"
          subtitle="Other people call you by this name. It is bound to your account and can't be changed here."
          value={userId || 'Not set'}
          icon="settingsUsername"
          testID="settings-username-row"
        />
        <ListItem
          title="Signed in with"
          value={accountLine}
          icon="settingsPrivacy"
          testID="settings-account-row"
        />

        {/* ── Notifications ───────────────────────────────────────────────── */}
        <SectionHeader title="Notifications" icon="settingsNotifications" />
        {onToggleMessageNotifications ? (
          <Switch
            label="Message notifications"
            hint="Notify me about new messages. Calls always ring."
            value={Boolean(messageNotificationsEnabled)}
            onValueChange={onToggleMessageNotifications}
            testID="settings-message-notifications"
          />
        ) : null}
        <Text style={styles.groupCaption}>Muted people</Text>
        {mutedPeers.length === 0 ? (
          <Text style={styles.hint} testID="settings-muted-empty">
            No one is muted. Mute someone from their profile to silence their messages.
          </Text>
        ) : (
          <View testID="settings-muted-people">
            {mutedPeers.map(peer => (
              <ListItem
                key={peer}
                title={peer}
                subtitle="Messages arrive silently"
                leading={<Avatar id={peer} size="sm" />}
                onPress={onOpenProfile ? () => onOpenProfile(peer) : undefined}
                accessibilityLabel={`${peer}, muted`}
                accessibilityHint={onOpenProfile ? `Opens ${peer}'s profile` : undefined}
                trailing={
                  onUnmutePeer ? (
                    <IconAction
                      icon="unmuteNotifications"
                      accessibilityLabel={`Unmute ${peer}`}
                      accessibilityHint="Lets their messages notify you again"
                      onPress={() => onUnmutePeer(peer)}
                      size={40}
                      testID="settings-unmute"
                    />
                  ) : null
                }
                testID="settings-muted-row"
              />
            ))}
          </View>
        )}

        {/* ── Calls & media ───────────────────────────────────────────────── */}
        {onToggleSpeakerDefault || onToggleAutoLighting ? (
          <>
            <SectionHeader title="Calls &amp; media" icon="settingsCalls" />
            {/* These two used to live inside the Lobby's developer-tools panel,
                which meant an ordinary user could not reach them at all. */}
            {onToggleSpeakerDefault ? (
              <Switch
                label="Speaker by default"
                hint="Start calls on the loudspeaker instead of the earpiece."
                value={Boolean(speakerDefaultEnabled)}
                onValueChange={onToggleSpeakerDefault}
                testID="settings-speaker-default"
              />
            ) : null}
            {onToggleAutoLighting ? (
              <Switch
                label="Auto camera lighting"
                hint="Brighten the camera automatically when the light is poor."
                value={Boolean(autoLightingEnabled)}
                onValueChange={onToggleAutoLighting}
                testID="settings-auto-lighting"
              />
            ) : null}
          </>
        ) : null}

        {/* ── Appearance ──────────────────────────────────────────────────── */}
        <SectionHeader title="Appearance" icon="settingsAppearance" />
        <Text style={styles.hint}>Follow the device theme, or pin the app to light or dark.</Text>
        <View
          style={styles.segmentedRow}
          accessibilityRole="radiogroup"
          testID="settings-theme-mode">
          {APPEARANCE_OPTIONS.map(option => {
            const isSelected = option.mode === themeMode;
            return (
              <Pressable
                key={option.mode}
                onPress={() => setThemeMode(option.mode)}
                accessibilityRole="radio"
                accessibilityLabel={`${option.label} theme`}
                accessibilityState={{ selected: isSelected, checked: isSelected }}
                testID={option.testID}
                style={({ pressed }) => [
                  styles.segment,
                  isSelected && styles.segmentSelected,
                  pressed && styles.pressed,
                ]}>
                <Text style={[styles.segmentLabel, isSelected && styles.segmentLabelSelected]}>
                  {option.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {/* ── Privacy ─────────────────────────────────────────────────────── */}
        <SectionHeader title="Privacy" icon="settingsPrivacy" />
        <Text style={styles.groupCaption}>Blocked people</Text>
        {blockedUsers.length === 0 ? (
          <Text style={styles.hint} testID="settings-blocked-empty">
            No one is blocked. Blocking someone stops their calls and messages both ways.
          </Text>
        ) : (
          <View testID="settings-blocked-people">
            {blockedUsers.map(peer => (
              <ListItem
                key={peer}
                title={peer}
                subtitle="Can't call or message you"
                leading={<Avatar id={peer} size="sm" />}
                onPress={onOpenProfile ? () => onOpenProfile(peer) : undefined}
                accessibilityLabel={`${peer}, blocked`}
                accessibilityHint={onOpenProfile ? `Opens ${peer}'s profile` : undefined}
                trailing={
                  onUnblockUser ? (
                    <AppButton
                      title="Unblock"
                      onPress={() => onUnblockUser(peer)}
                      style={styles.inlineButton}
                      accessibilityLabel={`Unblock ${peer}`}
                      accessibilityHint="Lets them call and message you again"
                      testID="settings-unblock"
                    />
                  ) : null
                }
                testID="settings-blocked-row"
              />
            ))}
          </View>
        )}

        {/* ── Storage & data ──────────────────────────────────────────────── */}
        <SectionHeader title="Storage & data" icon="settingsStorage" />
        <ListItem
          title="On this device"
          subtitle={
            isMeasuringStorage
              ? 'Measuring…'
              : storageUsage.measured
                ? `Media ${formatBytes(storageUsage.mediaBytes)} · `
                  + `Logs ${formatBytes(storageUsage.logBytes)} · `
                  + `Data ${formatBytes(storageUsage.dataBytes)}`
                : 'Storage use is unavailable on this device.'
          }
          value={
            isMeasuringStorage || !storageUsage.measured
              ? '—'
              : formatBytes(storageUsage.totalBytes)
          }
          icon="settingsStorage"
          accessibilityLabel={
            isMeasuringStorage
              ? 'Storage used on this device, measuring'
              : storageUsage.measured
                ? `Storage used on this device, ${formatBytes(storageUsage.totalBytes)}`
                : 'Storage used on this device, unavailable'
          }
          testID="settings-storage-usage"
        />
        {onClearCachedMedia ? (
          <ListItem
            title={isClearingMedia ? 'Clearing…' : 'Clear cached media'}
            subtitle={
              storageUsage.measured && storageUsage.mediaFileCount > 0
                ? `Frees about ${formatBytes(storageUsage.mediaBytes)}. `
                  + 'Photos and voice notes download again when you open them.'
                : 'Removes downloaded photos and voice notes. '
                  + 'They download again when you open them.'
            }
            icon="settingsMedia"
            onPress={isClearingMedia ? undefined : onClearCachedMedia}
            disabled={isClearingMedia}
            accessibilityLabel="Clear cached media"
            accessibilityHint="Removes downloaded photos and voice notes from this device"
            testID="settings-clear-media"
          />
        ) : null}
        {onExportLogs ? (
          <ListItem
            title="Export logs"
            subtitle="Share a copy of this device's diagnostic log."
            icon="settingsDeveloper"
            onPress={onExportLogs}
            accessibilityLabel="Export logs"
            accessibilityHint="Shares a copy of this device's diagnostic log"
            testID="settings-export-logs"
          />
        ) : null}

        {/* ── Advanced ────────────────────────────────────────────────────── */}
        <SectionHeader title="Advanced" icon="settingsDeveloper" />
        <ListItem
          title="Signaling server"
          subtitle="The server that routes your calls."
          value={signalingUrl || 'Not set'}
          icon="settingsServer"
          onPress={openSignalingEditor}
          accessibilityLabel="Signaling server"
          accessibilityHint="Opens an editor for the address of the server that routes your calls"
          testID="settings-signaling-row"
        />
        {onToggleDeveloperMode ? (
          <>
            <Switch
              label="Developer mode"
              hint="Show extra diagnostic tools, such as the ICE transport policy."
              value={Boolean(developerModeEnabled)}
              onValueChange={onToggleDeveloperMode}
              testID="settings-developer-mode"
            />
            {onChangeIceTransportPolicy && developerModeEnabled ? (
              <>
                <Text style={styles.toggleLabel}>ICE transport policy</Text>
                <Text style={styles.hint}>Force TURN relay for diagnostics, or use the default ICE path.</Text>
                <View
                  style={styles.segmentedRow}
                  accessibilityRole="radiogroup"
                  testID="settings-ice-policy">
                  {ICE_TRANSPORT_POLICY_OPTIONS.map(option => {
                    const isSelected = option.policy === activeIceTransportPolicy;
                    return (
                      <Pressable
                        key={option.policy}
                        onPress={() => onChangeIceTransportPolicy(option.policy)}
                        accessibilityRole="radio"
                        accessibilityLabel={`${option.label} ICE transport policy`}
                        accessibilityState={{ selected: isSelected, checked: isSelected }}
                        testID={option.testID}
                        style={({ pressed }) => [
                          styles.segment,
                          isSelected && styles.segmentSelected,
                          pressed && styles.pressed,
                        ]}>
                        <Text
                          style={[styles.segmentLabel, isSelected && styles.segmentLabelSelected]}>
                          {option.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </>
            ) : null}
          </>
        ) : null}
        {onExportLogs ? (
          <ListItem
            title="Export logs"
            subtitle="Share a copy of this device's diagnostic log."
            icon="settingsDeveloper"
            onPress={onExportLogs}
            accessibilityLabel="Export logs"
            accessibilityHint="Shares a copy of this device's diagnostic log"
            testID="settings-export-logs"
          />
        ) : null}

        {/* ── About ───────────────────────────────────────────────────────── */}
        <SectionHeader title="About" icon="settingsAbout" />
        <ListItem
          title="Version"
          subtitle={describePlatform()}
          value={APP_VERSION}
          icon="settingsAbout"
          accessibilityLabel={`Version ${APP_VERSION}`}
          testID="settings-version"
        />
        <ListItem
          title="Open-source licenses"
          subtitle={summarizeLicenses()}
          icon="settingsAbout"
          onPress={() => setIsShowingLicenses(true)}
          accessibilityLabel="Open-source licenses"
          accessibilityHint="Shows the licenses of the libraries this app is built with"
          testID="settings-licenses"
        />

        {/* ── Sign out ────────────────────────────────────────────────────── */}
        <Divider style={styles.signOutDivider} />
        <Pressable
          onPress={onSignOut}
          accessibilityRole="button"
          accessibilityLabel="Sign out"
          accessibilityHint="Clears your identity on this device and returns to registration"
          hitSlop={touchSlop(sizes.minTouchTarget)}
          testID="settings-sign-out"
          style={({ pressed }) => [styles.signOutButton, pressed && styles.pressed]}>
          <Text style={styles.signOutText}>Sign out</Text>
        </Pressable>
        <Text style={styles.signOutHint}>
          Signing out clears your identity on this device and stops incoming-call notifications
          until you register again.
        </Text>
      </ScrollView>

      {/* The one editable value on this screen gets the full width and an
          explicit commit, instead of a list-width input that can be edited by
          accident. */}
      <Sheet
        visible={isEditingSignalingUrl}
        onClose={() => setIsEditingSignalingUrl(false)}
        title="Signaling server"
        testID="settings-signaling-sheet">
        <Text style={styles.hint}>
          The server that routes your calls. Change this only if you were told to.
        </Text>
        <TextInput
          value={url}
          onChangeText={setUrl}
          placeholder="https://signaling.example.com"
          placeholderTextColor={colors.textSecondary}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          keyboardType="url"
          style={styles.input}
          accessibilityLabel="Signaling server URL"
          accessibilityHint="The address of the server that routes your calls"
          testID="settings-signaling-input"
        />
        <AppButton
          title="Save server"
          onPress={saveSignalingUrl}
          disabled={!urlDirty}
          testID="settings-save-signaling"
          style={styles.saveButton}
        />
      </Sheet>

      <Sheet
        visible={isShowingLicenses}
        onClose={() => setIsShowingLicenses(false)}
        title="Open-source licenses"
        testID="settings-licenses-sheet">
        <ScrollView style={styles.licenseList}>
          {THIRD_PARTY_LICENSES.map(license => (
            <ListItem
              key={license.name}
              title={license.name}
              value={license.license}
              testID="settings-license-row"
            />
          ))}
        </ScrollView>
      </Sheet>
    </KeyboardAvoidingView>
  );
}

/** @param colors */
const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
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
      marginBottom: spacing.md,
    },
    title: {
      ...typography.title,
      color: colors.textPrimary,
    },
    identity: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      padding: spacing.md,
      borderRadius: radius.md,
      backgroundColor: colors.surface,
    },
    identityText: {
      flex: 1,
      gap: 2,
    },
    identityName: {
      ...typography.subtitle,
      color: colors.textPrimary,
    },
    identityAccount: {
      ...typography.hint,
      color: colors.textSecondary,
    },
    // Capped so a long dependency list scrolls inside the sheet instead of
    // pushing the sheet past the top of the screen.
    licenseList: {
      maxHeight: sizes.sheetListMaxHeight,
    },
    groupCaption: {
      ...typography.label,
      color: colors.textPrimary,
      marginTop: spacing.sm,
      marginBottom: spacing.xs,
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
    // `AppButton` stretches to fill its row by default; inside a `ListItem`'s
    // trailing slot it must stay the width of its own label.
    inlineButton: {
      flex: 0,
      minHeight: sizes.minTouchTarget,
    },
    signOutDivider: {
      marginTop: spacing.xl,
      marginBottom: spacing.lg,
    },
    signOutButton: {
      minHeight: sizes.minTouchTarget,
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
    segmentedRow: {
      flexDirection: 'row',
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      padding: spacing.xs,
      gap: spacing.xs,
      marginBottom: spacing.sm,
    },
    segment: {
      flex: 1,
      minHeight: 48,
      borderRadius: radius.pill,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: spacing.sm,
    },
    segmentSelected: {
      backgroundColor: colors.accentButton,
    },
    segmentLabel: {
      color: colors.textSecondary,
      fontWeight: '600',
    },
    segmentLabelSelected: {
      color: colors.textOnAccent,
      fontWeight: '700',
    },
    toggleLabel: {
      color: colors.textPrimary,
      fontWeight: '600',
      marginBottom: 2,
    },
    pressed: {
      opacity: 0.78,
    },
  });

/**
 * Memoized: the settings screen re-renders only when its own props change, not merely
 * because an ancestor re-rendered.
 */
export default memo(SettingsScreen);

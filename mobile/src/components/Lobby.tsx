// @ts-check
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { CALL_END_REASON_LABELS } from '../hooks/useCallFlow';
import { formatCallDuration } from '../callUx';
import { useTheme, useThemedStyles } from '../ThemeContext';
import { radius, sizes, spacing, touchSlop } from '../theme';
import { ICONS, loadVectorIcons } from '../vectorIcons';
import AppButton from './AppButton';
import ErrorState from './ErrorState';
import SettingsCard from './SettingsCard';
import StatusBanner from './StatusBanner';

export type ContactRow = { userId: string; online?: boolean; };

/**
 * @param {object} props
 * @param {string} props.value
 * @param {(value: string) => void} props.onChangeText
 * @param {string} [props.placeholder]
 * @param {string} props.accessibilityLabel
 * @param {string} props.testID
 */
function ClearableInput({ value, onChangeText, placeholder, accessibilityLabel, testID }: { value: string; onChangeText: (value: string) => void; placeholder?: string; accessibilityLabel: string; testID: string; }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);

  return (
    <View style={styles.inputRow}>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.input}
        placeholder={placeholder}
        placeholderTextColor={colors.textSecondary}
        accessibilityLabel={accessibilityLabel}
        testID={testID}
      />
      {value ? (
        <Pressable
          onPress={() => onChangeText('')}
          accessibilityRole="button"
          accessibilityLabel={`Clear ${accessibilityLabel}`}
          hitSlop={touchSlop(32)}
          testID={`${testID}-clear`}
          style={styles.clearButton}>
          <Text style={styles.clearButtonText}>✕</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * Contact-directory search: a debounced query against the server's `GET /users`
 * endpoint (via `onSearchUsers`).  Tapping a result selects that user as the
 * callee (`onSelectContact`).  The section is hidden entirely when no
 * `onSearchUsers` handler is provided (i.e. when contact search is disabled).
 *
 * @param {object} props
 * @param {(query: string) => Promise<ContactRow[]>} [props.onSearchUsers]
 * @param {(peerId: string) => void} [props.onSelectContact]
 */
function ContactDirectory({ onSearchUsers, onSelectContact }: { onSearchUsers?: (query: string) => Promise<ContactRow[]>; onSelectContact?: (peerId: string) => void; }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);

  const [query, setQuery] = useState('');
  const [results, setResults] = useState(/** @type {ContactRow[]} */ ([]));
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const requestIdRef = useRef(0);

  const runSearch = useCallback(
    /** @param {string} term */
    async (term: string): string => {
      if (typeof onSearchUsers !== 'function') return;
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      setIsSearching(true);
      let /** @type {ContactRow[]} */ users: ContactRow[] = [];
      try {
        users = await onSearchUsers(term);
      } catch (_error) {
        users = [];
      }
      // Ignore stale responses that resolved out of order.
      if (requestIdRef.current !== requestId) return;
      setResults(Array.isArray(users) ? users : []);
      setIsSearching(false);
      setHasSearched(true);
    },
    [onSearchUsers],
  );

  // Debounce the directory lookup so we don't fire a request per keystroke.
  useEffect(() => {
    if (typeof onSearchUsers !== 'function') return undefined;
    const timer = setTimeout(() => {
      runSearch(query.trim());
    }, 300);
    return () => clearTimeout(timer);
  }, [query, onSearchUsers, runSearch]);

  if (typeof onSearchUsers !== 'function') return null;

  return (
    <View testID="contact-directory">
      <Text style={styles.sectionTitle} accessibilityRole="header">
        Contacts
      </Text>
      <ClearableInput
        value={query}
        onChangeText={setQuery}
        placeholder="Search contacts"
        accessibilityLabel="Search contacts"
        testID="input-contact-search"
      />
      {isSearching ? (
        <View style={styles.contactStatusRow} testID="contact-searching">
          <ActivityIndicator size="small" color={colors.textSecondary} />
          <Text style={styles.contactStatusText}>Searching…</Text>
        </View>
      ) : null}
      {!isSearching && results.length > 0
        ? results.map(contact => (
            <Pressable
              key={contact.userId}
              onPress={onSelectContact ? () => onSelectContact(contact.userId) : undefined}
              disabled={!onSelectContact}
              accessibilityRole="button"
              accessibilityLabel={`Select ${contact.userId}`}
              style={({ pressed }) => [styles.contactRow, pressed && styles.historyRowPressed]}
              testID="contact-row">
              <View
                style={[
                  styles.presenceDot,
                  contact.online ? styles.presenceDotOnline : styles.presenceDotOffline,
                ]}
              />
              <View style={styles.contactText}>
                <Text style={styles.contactName}>{contact.userId}</Text>
                <Text style={styles.contactDetail}>{contact.online ? 'Online' : 'Offline'}</Text>
              </View>
            </Pressable>
          ))
        : null}
      {!isSearching && hasSearched && results.length === 0 ? (
        <Text style={styles.contactEmpty} testID="contact-empty">
          No matching contacts
        </Text>
      ) : null}
    </View>
  );
}

/**
 * Pre-call lobby: branding, last-call summary, recent calls, the contact
 * directory and the call form.
 *
 * Calls are placed through the server-authoritative flow using `userId` /
 * `calleeId`; the server manages call state and drives the outgoing/incoming
 * screens.  The developer tools (diagnostic log export and the media settings
 * panel) are shown only when `developerMode` is enabled in Settings.
 *
 * @param {object} props
 * @param {string} props.userId
 * @param {(value: string) => void} props.onChangeUserId
 * @param {string} props.calleeId
 * @param {(value: string) => void} props.onChangeCalleeId
 * @param {() => void} props.onCall
 * @param {{ status: string, online: boolean, unknown?: boolean } | null} [props.calleePresence]
 * @param {() => void} [props.onOpenSettings]
 * @param {boolean} [props.isServerUnreachable]
 * @param {() => void} [props.onRetryConnect]
 * @param {(query: string) => Promise<ContactRow[]>} [props.onSearchUsers]
 * @param {(peerId: string) => void} [props.onSelectContact]
 * @param {() => void} [props.onOpenSearch]
 * @param {boolean} [props.developerMode]
 * @param {boolean} [props.isSettingsVisible]
 * @param {() => void} [props.onToggleSettings]
 * @param {() => void} [props.onExportLogs]
 * @param {Parameters<typeof SettingsCard>[0]['settings']} props.settings
 * @param {() => void} props.onToggleAutoLighting
 * @param {() => void} props.onToggleSpeakerDefault
 * @param {import('./StatusBanner').CallStatus} [props.status]
 * @param {{ durationSeconds: number | null, quality: string } | null} [props.callSummary]
 * @param {() => void} [props.onDismissSummary]
 * @param {import('../hooks/useCallHistory').CallHistoryEntry[]} [props.callHistory]
 * @param {number} [props.missedCallCount]
 * @param {() => void} [props.onMarkMissedRead]
 * @param {(peerId: string) => void} [props.onRedial]
 */
export default function Lobby({
  // ── Server-authoritative call flow ──────────────────────────────────────
  userId,
  onChangeUserId,
  calleeId,
  onChangeCalleeId,
  onCall,
  calleePresence,
  onOpenSettings,
  // ── Server connectivity ───────────────────────────────────────────────────
  isServerUnreachable,
  onRetryConnect,
  // ── Contact directory ─────────────────────────────────────────────────────
  onSearchUsers,
  onSelectContact,
  onOpenSearch,
  // ── Developer tools ───────────────────────────────────────────────────────
  developerMode,
  isSettingsVisible,
  onToggleSettings,
  onExportLogs,
  settings,
  onToggleAutoLighting,
  onToggleSpeakerDefault,
  status,
  callSummary,
  onDismissSummary,
  // ── Call history ──────────────────────────────────────────────────────────
  callHistory,
  missedCallCount = 0,
  onMarkMissedRead,
  onRedial,
}: { userId: string; onChangeUserId: (value: string) => void; calleeId: string; onChangeCalleeId: (value: string) => void; onCall: () => void; calleePresence?: { status: string; online: boolean; unknown?: boolean; } | null; onOpenSettings?: () => void; isServerUnreachable?: boolean; onRetryConnect?: () => void; onSearchUsers?: (query: string) => Promise<ContactRow[]>; onSelectContact?: (peerId: string) => void; onOpenSearch?: () => void; developerMode?: boolean; isSettingsVisible?: boolean; onToggleSettings?: () => void; onExportLogs?: () => void; settings: Parameters<typeof SettingsCard>[0]['settings']; onToggleAutoLighting: () => void; onToggleSpeakerDefault: () => void; status?: import('./StatusBanner').CallStatus; callSummary?: { durationSeconds: number | null; quality: string; } | null; onDismissSummary?: () => void; callHistory?: import('../hooks/useCallHistory').CallHistoryEntry[]; missedCallCount?: number; onMarkMissedRead?: () => void; onRedial?: (peerId: string) => void; }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);

  const MCIcon = loadVectorIcons();

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.titleRow}>
          <Text style={styles.title} accessibilityRole="header">
            WeTalk
          </Text>
          {missedCallCount > 0 ? (
            <Pressable
              onPress={onMarkMissedRead}
              accessibilityRole="button"
              accessibilityLabel={`${missedCallCount} missed call${
                missedCallCount === 1 ? '' : 's'
              }`}
              accessibilityHint="Marks missed calls as seen"
              hitSlop={touchSlop(24)}
              testID="missed-calls-badge"
              style={styles.missedBadge}>
              <Text style={styles.missedBadgeText}>{missedCallCount}</Text>
            </Pressable>
          ) : null}
          <View style={styles.titleSpacer} />
          {onOpenSearch ? (
            <Pressable
              onPress={onOpenSearch}
              accessibilityRole="button"
              accessibilityLabel="Search"
              accessibilityHint="Search contacts, conversations, messages and calls"
              hitSlop={touchSlop(44)}
              testID="lobby-open-search"
              style={styles.gearButton}>
              <Text style={styles.gearIcon}>🔍</Text>
            </Pressable>
          ) : null}
          {onOpenSettings ? (
            <Pressable
              onPress={onOpenSettings}
              accessibilityRole="button"
              accessibilityLabel="Settings"
              accessibilityHint="Opens account and connection settings"
              hitSlop={touchSlop(44)}
              testID="lobby-open-settings"
              style={styles.gearButton}>
              <Text style={styles.gearIcon}>⚙️</Text>
            </Pressable>
          ) : null}
        </View>
        <Text style={styles.subtitle}>Warm, simple one-to-one video calls</Text>

        {/* ── Offline / server-unreachable banner ─────────────────────── */}
        {isServerUnreachable ? (
          <ErrorState
            title="Server unreachable"
            description="Calls and messages can't be delivered until the app reconnects. Check your internet connection, or the signaling server address in Settings."
            actionLabel="Retry"
            actionHint="Tries to reconnect to the signaling server"
            onAction={onRetryConnect}
            testID="offline-banner"
          />
        ) : null}

        {callSummary ? (
          <View style={styles.summaryCard} accessibilityRole="summary">
            <View style={styles.summaryTextWrap}>
              <Text style={styles.summaryTitle}>Last call ended</Text>
              <Text style={styles.summaryDetail}>
                {`Duration ${formatCallDuration(callSummary.durationSeconds)} · ${
                  callSummary.quality
                }`}
              </Text>
            </View>
            <Pressable
              onPress={onDismissSummary}
              accessibilityRole="button"
              accessibilityLabel="Dismiss last call summary"
              hitSlop={touchSlop(28)}
              testID="dismiss-summary"
              style={styles.summaryDismiss}>
              <Text style={styles.summaryDismissText}>✕</Text>
            </Pressable>
          </View>
        ) : null}

        {Array.isArray(callHistory) && callHistory.length > 0 ? (
          <View testID="call-history-section">
            <Text style={styles.sectionTitle} accessibilityRole="header">
              Recent calls
            </Text>
            {callHistory.slice(0, 5).map(entry => {
              const isMissed =
                entry.direction === 'incoming' &&
                (entry.status === 'missed' || entry.endReason === 'timeout');
              const directionIconDef =
                ICONS[entry.direction === 'outgoing' ? 'callOutgoing' : 'callIncoming'];
              const directionColor = isMissed ? colors.danger : colors.textSecondary;
              const label =
                (entry.endReason ? CALL_END_REASON_LABELS[entry.endReason] : undefined) ??
                (entry.status ? CALL_END_REASON_LABELS[entry.status] : undefined) ??
                'Call';
              const peer = entry.direction === 'outgoing' ? entry.calleeId : entry.callerId;
              return (
                <Pressable
                  key={entry.callId}
                  onPress={onRedial && peer ? () => onRedial(peer) : undefined}
                  disabled={!onRedial || !peer}
                  accessibilityRole="button"
                  accessibilityLabel={peer ? `Call ${peer} back` : 'Call entry'}
                  style={({ pressed }) => [
                    styles.historyRow,
                    isMissed && styles.historyRowMissed,
                    pressed && styles.historyRowPressed,
                  ]}
                  testID="call-history-row">
                  <View style={styles.historyIconWrap}>
                    {directionIconDef && MCIcon ? (
                      <MCIcon name={directionIconDef.icon} size={18} color={directionColor} />
                    ) : (
                      <Text style={[styles.historyIcon, { color: directionColor }]}>
                        {directionIconDef?.emoji ?? (entry.direction === 'outgoing' ? '↑' : '↓')}
                      </Text>
                    )}
                  </View>
                  <View style={styles.historyText}>
                    <Text style={isMissed ? styles.historyPeerMissed : styles.historyPeer}>
                      {peer}
                    </Text>
                    <Text style={styles.historyDetail}>
                      {label}
                      {entry.durationSeconds != null
                        ? ` · ${formatCallDuration(entry.durationSeconds)}`
                        : ''}
                    </Text>
                  </View>
                  {onRedial && peer ? (
                    <View style={styles.historyRedialIconWrap}>
                      {MCIcon ? (
                        <MCIcon name={ICONS.callRedial.icon} size={20} color={colors.accent} />
                      ) : (
                        <Text style={styles.historyRedialIcon}>{ICONS.callRedial.emoji}</Text>
                      )}
                    </View>
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        ) : null}

        {/* ── Server-authoritative call section ─────────────────────────── */}
        <Text style={styles.sectionTitle} accessibilityRole="header">
          Call
        </Text>

        <ClearableInput
          value={userId}
          onChangeText={onChangeUserId}
          placeholder="Your user ID"
          accessibilityLabel="Your user ID"
          testID="input-user-id"
        />
        <ClearableInput
          value={calleeId}
          onChangeText={onChangeCalleeId}
          placeholder="Callee user ID"
          accessibilityLabel="Callee user ID"
          testID="input-callee-id"
        />

        {calleeId?.trim() && calleePresence ? (
          <View style={styles.presenceRow} testID="callee-presence">
            <View
              style={[
                styles.presenceDot,
                calleePresence.online ? styles.presenceDotOnline : styles.presenceDotOffline,
              ]}
            />
            <Text style={styles.presenceText}>
              {calleePresence.unknown
                ? 'User not found'
                : calleePresence.online
                ? 'Online'
                : 'Offline — they may miss your call'}
            </Text>
          </View>
        ) : null}

        <AppButton
          title="Call"
          onPress={onCall}
          disabled={!userId?.trim() || !calleeId?.trim()}
          accessibilityHint={
            calleeId?.trim()
              ? `Starts a call with ${calleeId.trim()}`
              : 'Enter a callee user ID first'
          }
          testID="lobby-call"
          style={styles.callButton}
        />

        <ContactDirectory onSearchUsers={onSearchUsers} onSelectContact={onSelectContact} />

        {/* ── Developer tools (developer mode only) ──────────────────────── */}
        {developerMode ? (
          <View testID="developer-tools-section">
            <Text style={styles.sectionTitle} accessibilityRole="header">
              Developer tools
            </Text>

            <View style={styles.row}>
              <AppButton
                title={isSettingsVisible ? 'Hide Settings' : 'Settings'}
                onPress={onToggleSettings}
                testID="lobby-settings"
              />
              <AppButton title="Export Logs" onPress={onExportLogs} testID="lobby-export-logs" />
            </View>

            {isSettingsVisible ? (
              <SettingsCard
                settings={settings}
                onToggleAutoLighting={onToggleAutoLighting}
                onToggleSpeakerDefault={onToggleSpeakerDefault}
              />
            ) : null}
          </View>
        ) : null}

        <StatusBanner status={status} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/** @param {import('../theme').ThemeColors} colors */
const createStyles = (colors: import('../theme').ThemeColors): import('../theme').ThemeColors =>
  StyleSheet.create({
    flex: {
      flex: 1,
    },
    content: {
      padding: spacing.lg,
    },
    titleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    title: {
      fontSize: 28,
      fontWeight: '600',
      color: colors.textPrimary,
    },
    missedBadge: {
      backgroundColor: colors.danger,
      borderRadius: 12,
      minWidth: 24,
      height: 24,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 6,
    },
    missedBadgeText: {
      color: '#fff',
      fontSize: 12,
      fontWeight: '700',
    },
    titleSpacer: {
      flex: 1,
    },
    gearButton: {
      height: 44,
      width: 44,
      borderRadius: 22,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surfaceControl,
    },
    gearIcon: {
      fontSize: 18,
    },
    presenceRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      marginTop: -spacing.sm + 2,
      marginBottom: spacing.sm,
    },
    presenceDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
    },
    presenceDotOnline: {
      backgroundColor: colors.success,
    },
    presenceDotOffline: {
      backgroundColor: colors.textSecondary,
    },
    presenceText: {
      color: colors.textSecondary,
      fontSize: 12,
    },
    subtitle: {
      fontSize: 14,
      color: colors.textSecondary,
      marginBottom: spacing.lg,
    },
    summaryCard: {
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surfaceRaised,
      padding: spacing.md,
      marginBottom: spacing.lg,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    summaryTextWrap: {
      flexShrink: 1,
    },
    summaryTitle: {
      color: colors.textPrimary,
      fontWeight: '700',
    },
    summaryDetail: {
      color: colors.textSecondary,
      fontSize: 12,
      marginTop: 2,
    },
    summaryDismiss: {
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
    },
    summaryDismissText: {
      color: colors.textSecondary,
      fontWeight: '700',
    },
    inputRow: {
      position: 'relative',
      justifyContent: 'center',
      marginBottom: spacing.md,
    },
    input: {
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      color: colors.textPrimary,
      paddingHorizontal: spacing.md,
      paddingVertical: 10,
      paddingRight: 40,
    },
    clearButton: {
      position: 'absolute',
      right: spacing.sm,
      height: 32,
      width: 32,
      alignItems: 'center',
      justifyContent: 'center',
    },
    clearButtonText: {
      color: colors.textSecondary,
      fontWeight: '700',
    },
    row: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      gap: 10,
      marginBottom: spacing.sm,
    },
    sectionTitle: {
      fontSize: 13,
      fontWeight: '700',
      color: colors.textSecondary,
      textTransform: 'uppercase',
      letterSpacing: 0.8,
      marginTop: spacing.lg,
      marginBottom: spacing.sm,
    },
    callButton: {
      marginBottom: spacing.sm,
    },
    contactStatusRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      marginBottom: spacing.sm,
    },
    contactStatusText: {
      color: colors.textSecondary,
      fontSize: 12,
    },
    contactRow: {
      flexDirection: 'row',
      alignItems: 'center',
      minHeight: sizes.minTouchTarget,
      paddingVertical: spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      gap: spacing.sm,
    },
    contactText: {
      flex: 1,
    },
    contactName: {
      color: colors.textPrimary,
      fontSize: 14,
    },
    contactDetail: {
      color: colors.textSecondary,
      fontSize: 11,
      marginTop: 1,
    },
    contactEmpty: {
      color: colors.textSecondary,
      fontSize: 12,
      paddingVertical: spacing.sm,
    },
    historyRow: {
      flexDirection: 'row',
      alignItems: 'center',
      minHeight: sizes.minTouchTarget,
      paddingVertical: spacing.xs,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      gap: spacing.sm,
    },
    historyRowMissed: {
      backgroundColor: colors.surfaceRaised ?? colors.surface,
    },
    historyRowPressed: {
      opacity: 0.6,
    },
    historyIconWrap: {
      width: 24,
      alignItems: 'center',
      justifyContent: 'center',
    },
    historyIcon: {
      fontSize: 16,
      textAlign: 'center',
    },
    historyRedialIconWrap: {
      width: 28,
      alignItems: 'center',
      justifyContent: 'center',
      marginLeft: spacing.sm,
    },
    historyRedialIcon: {
      fontSize: 18,
      textAlign: 'center',
    },
    historyText: {
      flex: 1,
    },
    historyPeer: {
      color: colors.textPrimary,
      fontSize: 14,
    },
    historyPeerMissed: {
      color: colors.danger,
      fontSize: 14,
      fontWeight: '600',
    },
    historyDetail: {
      color: colors.textSecondary,
      fontSize: 11,
      marginTop: 1,
    },
  });

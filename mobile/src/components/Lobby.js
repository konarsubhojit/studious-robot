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
import SafeRTCView from '../SafeRTCView';
import { CALL_END_REASON_LABELS } from '../hooks/useCallFlow';
import { formatCallDuration } from '../callUx';
import { colors, radius, sizes, spacing } from '../theme';
import { ICONS, loadVectorIcons } from '../vectorIcons';
import AppButton from './AppButton';
import SettingsCard from './SettingsCard';
import StatusBanner from './StatusBanner';

function ClearableInput({ value, onChangeText, placeholder, accessibilityLabel, testID }) {
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
          testID={`${testID}-clear`}
          style={styles.clearButton}
        >
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
 */
function ContactDirectory({ onSearchUsers, onSelectContact }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const requestIdRef = useRef(0);

  const runSearch = useCallback(
    async (term) => {
      if (typeof onSearchUsers !== 'function') return;
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      setIsSearching(true);
      let users = [];
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
      <Text style={styles.sectionTitle}>Contacts</Text>
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
        ? results.map((contact) => (
            <Pressable
              key={contact.userId}
              onPress={
                onSelectContact ? () => onSelectContact(contact.userId) : undefined
              }
              disabled={!onSelectContact}
              accessibilityRole="button"
              accessibilityLabel={`Select ${contact.userId}`}
              style={({ pressed }) => [
                styles.contactRow,
                pressed && styles.historyRowPressed,
              ]}
              testID="contact-row"
            >
              <View
                style={[
                  styles.presenceDot,
                  contact.online ? styles.presenceDotOnline : styles.presenceDotOffline,
                ]}
              />
              <View style={styles.contactText}>
                <Text style={styles.contactName}>{contact.userId}</Text>
                <Text style={styles.contactDetail}>
                  {contact.online ? 'Online' : 'Offline'}
                </Text>
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
 * Pre-call lobby: branding, last-call summary, self preview, connection inputs,
 * primary actions, and the settings panel.
 *
 * The lobby exposes two ways to start a call:
 *   1. **Call** – server-authoritative flow using `userId` / `calleeId`.
 *      The server manages call state and drives the outgoing/incoming screens.
 *   2. **Join Room** – legacy direct-room flow using a shared `roomId`.
 *      Only shown when `developerMode` is enabled (toggled in Settings).
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
  // ── Legacy room-join flow ────────────────────────────────────────────────
  developerMode,
  signalingUrl,
  onChangeSignalingUrl,
  roomId,
  onChangeRoomId,
  localPreviewStreamUrl,
  hasLocalStream,
  onStartPreview,
  onJoinRoom,
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
  missedCallCount,
  onMarkMissedRead,
  onRedial,
}) {
  const MCIcon = loadVectorIcons();

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.titleRow}>
          <Text style={styles.title}>WeTalk</Text>
          {missedCallCount > 0 ? (
            <Pressable
              onPress={onMarkMissedRead}
              accessibilityRole="button"
              accessibilityLabel={`${missedCallCount} missed call${missedCallCount === 1 ? '' : 's'}`}
              testID="missed-calls-badge"
              style={styles.missedBadge}
            >
              <Text style={styles.missedBadgeText}>{missedCallCount}</Text>
            </Pressable>
          ) : null}
          <View style={styles.titleSpacer} />
          {onOpenSettings ? (
            <Pressable
              onPress={onOpenSettings}
              accessibilityRole="button"
              accessibilityLabel="Settings"
              testID="lobby-open-settings"
              style={styles.gearButton}
            >
              <Text style={styles.gearIcon}>⚙️</Text>
            </Pressable>
          ) : null}
        </View>
        <Text style={styles.subtitle}>Warm, simple one-to-one video calls</Text>

        {/* ── Offline / server-unreachable banner ─────────────────────── */}
        {isServerUnreachable ? (
          <View style={styles.offlineBanner} accessibilityRole="alert" testID="offline-banner">
            <Text style={styles.offlineBannerText}>
            Cannot reach server - check your connection
            </Text>
            {onRetryConnect ? (
              <Pressable
                onPress={onRetryConnect}
                accessibilityRole="button"
                accessibilityLabel="Retry server connection"
                testID="offline-retry"
                style={styles.offlineRetryButton}
              >
                <Text style={styles.offlineRetryText}>Retry</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {callSummary ? (
          <View style={styles.summaryCard} accessibilityRole="summary">
            <View style={styles.summaryTextWrap}>
              <Text style={styles.summaryTitle}>Last call ended</Text>
              <Text style={styles.summaryDetail}>
                {`Duration ${formatCallDuration(callSummary.durationSeconds)} · ${callSummary.quality}`}
              </Text>
            </View>
            <Pressable
              onPress={onDismissSummary}
              accessibilityRole="button"
              accessibilityLabel="Dismiss last call summary"
              testID="dismiss-summary"
              style={styles.summaryDismiss}
            >
              <Text style={styles.summaryDismissText}>✕</Text>
            </Pressable>
          </View>
        ) : null}

        {Array.isArray(callHistory) && callHistory.length > 0 ? (
          <View testID="call-history-section">
            <Text style={styles.sectionTitle}>Recent calls</Text>
            {callHistory.slice(0, 5).map((entry) => {
              const isMissed =
                entry.direction === 'incoming' &&
                (entry.status === 'missed' || entry.endReason === 'timeout');
              const directionIconDef = ICONS[entry.direction === 'outgoing' ? 'callOutgoing' : 'callIncoming'];
              const directionColor = isMissed ? colors.danger : colors.textSecondary;
              const label = CALL_END_REASON_LABELS[entry.endReason] ??
                            CALL_END_REASON_LABELS[entry.status] ?? 'Call';
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
                  testID="call-history-row"
                >
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

        {hasLocalStream ? (
          <SafeRTCView
            fallbackLabel="Preview unavailable"
            style={styles.previewStream}
            streamURL={localPreviewStreamUrl}
            objectFit="cover"
            mirror
          />
        ) : null}

        {/* ── Server-authoritative call section ─────────────────────────── */}
        <Text style={styles.sectionTitle}>Call</Text>

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
          testID="lobby-call"
          style={styles.callButton}
        />

        <ContactDirectory
          onSearchUsers={onSearchUsers}
          onSelectContact={onSelectContact}
        />

        {/* ── Legacy room-join section (developer mode only) ─────────────── */}
        {developerMode ? (
          <View testID="developer-room-section">
            <Text style={styles.sectionTitle}>Join Room</Text>

            <ClearableInput
              value={signalingUrl}
              onChangeText={onChangeSignalingUrl}
              placeholder="Signaling URL"
              accessibilityLabel="Signaling URL"
              testID="input-signaling-url"
            />
            <ClearableInput
              value={roomId}
              onChangeText={onChangeRoomId}
              placeholder="Room ID"
              accessibilityLabel="Room ID"
              testID="input-room-id"
            />

            <View style={styles.row}>
              <AppButton title="Start Preview" onPress={onStartPreview} testID="lobby-start-preview" />
              <AppButton title="Join Room" onPress={onJoinRoom} testID="lobby-join-room" />
            </View>

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

const styles = StyleSheet.create({
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
    height: 36,
    width: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceControl,
  },
  gearIcon: {
    fontSize: 18,
  },
  offlineBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: 'rgba(240,141,137,0.15)',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.danger,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.md,
    gap: spacing.sm,
  },
  offlineBannerText: {
    flex: 1,
    color: colors.danger,
    fontSize: 13,
    fontWeight: '600',
  },
  offlineRetryButton: {
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    backgroundColor: colors.danger,
  },
  offlineRetryText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 12,
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
  previewStream: {
    height: 220,
    borderRadius: radius.lg,
    marginBottom: spacing.lg,
    overflow: 'hidden',
    backgroundColor: colors.backgroundAlt,
    borderWidth: 1,
    borderColor: colors.border,
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
    height: 28,
    width: 28,
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

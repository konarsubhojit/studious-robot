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
import SafeRTCView from '../SafeRTCView';
import { CALL_END_REASON_LABELS } from '../hooks/useCallFlow';
import { formatCallDuration } from '../callUx';
import { colors, radius, spacing } from '../theme';
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
 * Pre-call lobby: branding, last-call summary, self preview, connection inputs,
 * primary actions, and the settings panel.
 *
 * The lobby exposes two ways to start a call:
 *   1. **Call** – server-authoritative flow using `userId` / `calleeId`.
 *      The server manages call state and drives the outgoing/incoming screens.
 *   2. **Join Room** – legacy direct-room flow using a shared `roomId`.
 */
export default function Lobby({
  // ── Server-authoritative call flow ──────────────────────────────────────
  userId,
  onChangeUserId,
  calleeId,
  onChangeCalleeId,
  onCall,
  // ── Legacy room-join flow ────────────────────────────────────────────────
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
}) {
  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.titleRow}>
          <Text style={styles.title}>TCalling</Text>
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
        </View>
        <Text style={styles.subtitle}>Warm, simple one-to-one video calls</Text>

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
              const directionIcon = entry.direction === 'outgoing' ? '↑' : '↓';
              const label = CALL_END_REASON_LABELS[entry.endReason] ??
                            CALL_END_REASON_LABELS[entry.status] ?? 'Call';
              const peer = entry.direction === 'outgoing' ? entry.calleeId : entry.callerId;
              return (
                <View
                  key={entry.callId}
                  style={[styles.historyRow, isMissed && styles.historyRowMissed]}
                  testID="call-history-row"
                >
                  <Text style={isMissed ? styles.historyIconMissed : styles.historyIcon}>
                    {directionIcon}
                  </Text>
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
                </View>
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

        <AppButton
          title="Call"
          onPress={onCall}
          disabled={!userId?.trim() || !calleeId?.trim()}
          testID="lobby-call"
          style={styles.callButton}
        />

        {/* ── Legacy room-join section ───────────────────────────────────── */}
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
  historyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.sm,
  },
  historyRowMissed: {
    backgroundColor: colors.surfaceRaised ?? colors.surface,
  },
  historyIcon: {
    fontSize: 14,
    color: colors.textSecondary,
    width: 16,
    textAlign: 'center',
  },
  historyIconMissed: {
    fontSize: 14,
    color: colors.danger,
    width: 16,
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

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
 */
export default function Lobby({
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
}) {
  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>TCalling</Text>
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

        {hasLocalStream ? (
          <SafeRTCView
            fallbackLabel="Preview unavailable"
            style={styles.previewStream}
            streamURL={localPreviewStreamUrl}
            objectFit="cover"
            mirror
          />
        ) : null}

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
  title: {
    fontSize: 28,
    fontWeight: '600',
    color: colors.textPrimary,
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
});

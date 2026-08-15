import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radius, spacing, typography } from '../theme';

function SettingsToggle({ label, hint, value, onPress, testID }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ checked: value }}
      testID={testID}
      style={({ pressed }) => [styles.settingsOption, pressed && styles.settingsOptionPressed]}
    >
      <View style={styles.settingsOptionTextWrap}>
        <Text style={styles.settingsOptionLabel}>{label}</Text>
        <Text style={styles.settingsOptionHint}>{hint}</Text>
      </View>
      <Text style={styles.settingsOptionValue}>{value ? 'On' : 'Off'}</Text>
    </Pressable>
  );
}

/**
 * Settings panel exposing persisted preferences.
 *
 * @param {object} props
 * @param {{ autoCameraLightingEnabled: boolean, speakerEnabledByDefault: boolean }} props.settings
 * @param {() => void} props.onToggleAutoLighting
 * @param {() => void} props.onToggleSpeakerDefault
 */
export default function SettingsCard({ settings, onToggleAutoLighting, onToggleSpeakerDefault }) {
  return (
    <View style={styles.settingsCard}>
      <Text style={styles.settingsTitle}>Settings</Text>
      <SettingsToggle
        label="Auto camera lighting"
        hint="Automatically adjusts camera for lighting conditions"
        value={settings.autoCameraLightingEnabled}
        onPress={onToggleAutoLighting}
        testID="setting-auto-lighting"
      />
      <SettingsToggle
        label="Speaker on join"
        hint="Default audio route for new calls"
        value={settings.speakerEnabledByDefault}
        onPress={onToggleSpeakerDefault}
        testID="setting-speaker-default"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  settingsCard: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
    padding: spacing.sm + 2,
    marginBottom: spacing.md,
    gap: spacing.sm,
  },
  settingsTitle: {
    ...typography.sectionTitle,
    color: colors.textPrimary,
  },
  settingsOption: {
    borderRadius: radius.sm + 2,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceControl,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: 9,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm + 2,
  },
  settingsOptionPressed: {
    opacity: 0.85,
  },
  settingsOptionTextWrap: {
    flexShrink: 1,
  },
  settingsOptionLabel: {
    color: colors.textPrimary,
    fontWeight: '600',
  },
  settingsOptionHint: {
    color: colors.textSecondary,
    fontSize: 12,
  },
  settingsOptionValue: {
    color: colors.accentValue,
    fontWeight: '700',
    minWidth: 28,
    textAlign: 'right',
  },
});

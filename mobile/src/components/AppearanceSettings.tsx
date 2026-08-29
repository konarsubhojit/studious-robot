import { Pressable, StyleSheet, Text, View } from 'react-native';
import { announceForAccessibility, describeAppearanceChange } from '../accessibilityAnnouncer';
import { useTheme, useThemedStyles } from '../ThemeContext';
import {
  buildPalette,
  elevation,
  fontScaleCaps,
  radius,
  sizes,
  spacing,
  TEXT_SCALE_LABELS,
  TEXT_SCALE_VALUES,
  THEME_ACCENT_LABELS,
  THEME_ACCENT_VALUES,
  THEME_CONTRASTS,
  THEME_MODES,
  touchSlop,
  typography,
} from '../theme';
import { Icon, SegmentedControl } from './primitives';
import Switch from './primitives/Switch';
import type { TextScale, ThemeAccent, ThemeColors, ThemeMode } from '../theme';

const MODE_OPTIONS: ReadonlyArray<{ value: ThemeMode; label: string; testID: string }> = [
  { value: THEME_MODES.SYSTEM, label: 'System', testID: 'settings-theme-system' },
  { value: THEME_MODES.LIGHT, label: 'Light', testID: 'settings-theme-light' },
  { value: THEME_MODES.DARK, label: 'Dark', testID: 'settings-theme-dark' },
];

const TEXT_SCALE_OPTIONS: ReadonlyArray<{ value: TextScale; label: string; testID: string }> =
  TEXT_SCALE_VALUES.map(value => ({
    value,
    label: TEXT_SCALE_LABELS[value],
    testID: `settings-text-scale-${value}`,
  }));

/** Diameter of an accent swatch; comfortably inside the minimum touch target. */
const SWATCH_SIZE = 40;

/**
 * The Appearance group of Settings.
 *
 * Split out of `SettingsScreen` because it grew from one three-way picker into
 * five related controls plus a preview, and because those controls are the only
 * part of Settings whose *state* is the theme itself — everything else on that
 * screen is passed in as props.
 *
 * Each control does something the user can see immediately, which is why the
 * preview exists: an accent or a contrast change otherwise only shows up on
 * some other screen, so the choice is made blind and then verified by leaving.
 *
 * Two things are deliberate:
 *
 * - **True black only appears in the dark scheme.** In light it would be a
 *   control that visibly does nothing, and the house rule is to ship no dead
 *   affordances — so it is hidden rather than disabled.
 * - **Contrast is a switch over a tri-state preference.** The stored value can
 *   also be "follow the OS", which is the default; the switch reports the
 *   *resolved* contrast, and touching it pins an explicit choice. That way a
 *   user who already turned on high-contrast text at the OS level gets it here
 *   without being asked twice.
 */
export default function AppearanceSettings() {
  const { scheme, contrast, preferences, setMode, setPreference } = useTheme();
  const styles = useThemedStyles(createStyles);

  const announce = (setting: string, value: string) => {
    const message = describeAppearanceChange(setting, value);
    if (message) announceForAccessibility(message);
  };

  const chooseMode = (mode: ThemeMode) => {
    setMode(mode);
    announce('Appearance', MODE_OPTIONS.find(option => option.value === mode)?.label ?? mode);
  };

  const chooseAccent = (accent: ThemeAccent) => {
    setPreference('accent', accent);
    announce('Accent colour', THEME_ACCENT_LABELS[accent]);
  };

  const chooseTextScale = (textScale: TextScale) => {
    setPreference('textScale', textScale);
    announce('Text size', TEXT_SCALE_LABELS[textScale]);
  };

  const setHighContrast = (next: boolean) => {
    setPreference('contrast', next ? THEME_CONTRASTS.HIGH : THEME_CONTRASTS.STANDARD);
    announce('High contrast', next ? 'On' : 'Off');
  };

  const setTrueBlack = (next: boolean) => {
    setPreference('trueBlack', next);
    announce('True black', next ? 'On' : 'Off');
  };

  return (
    <View testID="settings-appearance">
      <Text style={styles.hint}>Follow the device theme, or pin the app to light or dark.</Text>
      <SegmentedControl
        options={MODE_OPTIONS}
        value={preferences.mode}
        onChange={chooseMode}
        accessibilityLabel="Appearance"
        style={styles.control}
        testID="settings-theme-mode"
      />

      <Text style={styles.groupCaption}>Accent colour</Text>
      <View
        style={styles.swatchRow}
        accessibilityRole="radiogroup"
        accessibilityLabel="Accent colour"
        testID="settings-accent">
        {THEME_ACCENT_VALUES.map(accent => {
          const isSelected = accent === preferences.accent;
          // Each swatch is painted in the accent it *would* apply, taken from
          // that variant's palette rather than the active one — a row of
          // identically coloured swatches would make the choice invisible.
          const preview = buildPalette({
            scheme,
            contrast,
            accent,
            trueBlack: preferences.trueBlack,
          });
          return (
            <Pressable
              key={accent}
              onPress={() => chooseAccent(accent)}
              accessibilityRole="radio"
              accessibilityLabel={THEME_ACCENT_LABELS[accent]}
              accessibilityState={{ selected: isSelected, checked: isSelected }}
              hitSlop={touchSlop(SWATCH_SIZE)}
              testID={`settings-accent-${accent}`}
              style={({ pressed }) => [
                styles.swatch,
                { backgroundColor: preview.accentButton },
                isSelected && styles.swatchSelected,
                pressed && styles.pressed,
              ]}>
              {isSelected ? <Icon name="check" size={20} color={preview.textOnAccent} /> : null}
            </Pressable>
          );
        })}
      </View>

      <Text style={styles.groupCaption}>Text size</Text>
      <SegmentedControl
        options={TEXT_SCALE_OPTIONS}
        value={preferences.textScale}
        onChange={chooseTextScale}
        accessibilityLabel="Text size"
        style={styles.control}
        testID="settings-text-scale"
      />

      <Switch
        label="High contrast"
        hint="Stronger text and outlines. Follows the device setting until you choose here."
        value={contrast === 'high'}
        onValueChange={setHighContrast}
        testID="settings-high-contrast"
      />
      {scheme === 'dark' ? (
        <Switch
          label="True black"
          hint="Pure black backgrounds, which save power on OLED screens."
          value={preferences.trueBlack}
          onValueChange={setTrueBlack}
          testID="settings-true-black"
        />
      ) : null}

      <AppearancePreview />
    </View>
  );
}

/**
 * A miniature of the surfaces the choices above actually change.
 *
 * Deliberately made of the same tokens the real screens use — a section
 * heading, an incoming and an outgoing bubble, a primary button — so it cannot
 * drift away from what it claims to preview. It is decorative for assistive
 * technology (the controls already announce their own changes), so the whole
 * card is hidden from the accessibility tree rather than read out as a chat
 * message that does not exist.
 */
function AppearancePreview() {
  const styles = useThemedStyles(createStyles);

  return (
    <View
      style={styles.preview}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID="settings-appearance-preview">
      <Text style={styles.previewHeading}>Preview</Text>
      <View style={styles.bubbleIncoming}>
        <Text style={styles.bubbleIncomingText}>Are we still on for tonight?</Text>
      </View>
      <View style={styles.bubbleOutgoing}>
        <Text style={styles.bubbleOutgoingText}>Yes — call you at eight.</Text>
      </View>
      <View style={styles.previewButton}>
        <Text style={styles.previewButtonText} maxFontSizeMultiplier={fontScaleCaps.control}>
          Call
        </Text>
      </View>
    </View>
  );
}

/** @param colors */
const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    hint: {
      ...typography.hint,
      color: colors.onSurfaceVariant,
      marginBottom: spacing.sm,
    },
    groupCaption: {
      ...typography.groupLabel,
      color: colors.onSurfaceVariant,
      marginTop: spacing.md,
      marginBottom: spacing.sm,
    },
    control: {
      marginBottom: spacing.sm,
    },
    swatchRow: {
      flexDirection: 'row',
      gap: spacing.sm,
      marginBottom: spacing.sm,
    },
    swatch: {
      width: SWATCH_SIZE,
      height: SWATCH_SIZE,
      borderRadius: radius.pill,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: colors.outline,
    },
    swatchSelected: {
      borderWidth: 3,
      borderColor: colors.onSurface,
    },
    pressed: {
      opacity: 0.78,
    },
    preview: {
      marginTop: spacing.md,
      padding: spacing.md,
      gap: spacing.sm,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.outlineVariant,
      backgroundColor: colors.surface,
      ...elevation(colors.shadow).low,
    },
    previewHeading: {
      ...typography.groupLabel,
      color: colors.onSurfaceVariant,
    },
    bubbleIncoming: {
      alignSelf: 'flex-start',
      maxWidth: '85%',
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderRadius: radius.lg,
      backgroundColor: colors.surfaceRaised,
    },
    bubbleIncomingText: {
      ...typography.body,
      color: colors.onSurface,
    },
    bubbleOutgoing: {
      alignSelf: 'flex-end',
      maxWidth: '85%',
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderRadius: radius.lg,
      backgroundColor: colors.accentButton,
    },
    bubbleOutgoingText: {
      ...typography.body,
      color: colors.textOnAccent,
    },
    previewButton: {
      alignSelf: 'flex-start',
      minHeight: sizes.minTouchTarget,
      paddingHorizontal: spacing.xl,
      borderRadius: radius.pill,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.accentButton,
    },
    previewButtonText: {
      ...typography.label,
      color: colors.textOnAccent,
    },
  });

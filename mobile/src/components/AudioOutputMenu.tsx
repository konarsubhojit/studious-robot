// @ts-check
import { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { AUDIO_ROUTES, getAudioRouteLabel } from '../audioRouting';
import { useThemedStyles } from '../ThemeContext';
import { radius, spacing } from '../theme';
import IconButton from './IconButton';

// Speaker and earpiece are always selectable; Bluetooth and wired headset are
// merged in only when the OS reports them as available.
const BASE_ROUTES = [AUDIO_ROUTES.SPEAKER_PHONE, AUDIO_ROUTES.EARPIECE];

/**
 * Merge the OS-reported routes into the always-available base routes.
 *
 * @param {string[]} [available]
 * @returns {string[]}
 */
function buildRouteList(available: string[]): string[] {
  const routes = [...BASE_ROUTES];
  (available || []).forEach(route => {
    if (!routes.includes(route)) {
      routes.push(route);
    }
  });
  return routes;
}

/**
 * Dropdown control letting the user pick the call audio output (speaker,
 * earpiece, Bluetooth headset, wired headset).  Bluetooth/wired entries appear
 * automatically when the device reports them as available.
 *
 * @param {object} props
 * @param {string[]} [props.available] - Device names reported by the OS.
 * @param {string|null} [props.selected] - Currently selected device name.
 * @param {boolean} props.isSpeakerEnabled - Fallback selection when none reported.
 * @param {(route: string) => void} props.onSelect
 * @param {boolean} [props.disabled]
 */
export default function AudioOutputMenu({
  available,
  selected,
  isSpeakerEnabled,
  onSelect,
  disabled = false,
}: { available?: string[]; selected?: string | null; isSpeakerEnabled: boolean; onSelect: (route: string) => void; disabled?: boolean; }) {
  const styles = useThemedStyles(createStyles);

  const [isOpen, setIsOpen] = useState(false);
  const routes = useMemo(() => buildRouteList(available), [available]);

  const effectiveSelected =
    selected || (isSpeakerEnabled ? AUDIO_ROUTES.SPEAKER_PHONE : AUDIO_ROUTES.EARPIECE);
  const currentLabel = getAudioRouteLabel(effectiveSelected);
  const currentIcon = effectiveSelected === AUDIO_ROUTES.SPEAKER_PHONE ? 'speaker' : 'speakerOff';

  /** @param {string} route */
  const handleSelect = (route: string): string => {
    setIsOpen(false);
    onSelect(route);
  };

  // The trigger is disabled when the call has no local media (call ending,
  // media released). Leaving the dropdown open in that state strands its
  // layer over the call UI, so it is closed with the control it belongs to.
  useEffect(() => {
    if (disabled) setIsOpen(false);
  }, [disabled]);

  return (
    // A plain View (not a fragment): the parent control deck lays its children
    // out in a gapped flex row, and a second child — even the zero-sized modal
    // host — adds a phantom slot that shifts the icons out of alignment.
    <View style={styles.trigger}>
      <IconButton
        icon={currentIcon}
        onPress={() => setIsOpen(true)}
        disabled={disabled}
        variant="default"
        size={56}
        accessibilityLabel={`Audio output: ${currentLabel}. Tap to change`}
        testID="audio-output-trigger"
      />

      {/* Rendered only while open: an invisible-but-mounted modal keeps a
          stale layer (and its icons) in the tree after the menu is closed. */}
      {isOpen ? (
        <Modal visible transparent animationType="fade" onRequestClose={() => setIsOpen(false)}>
          <Pressable
            style={styles.backdrop}
            accessibilityLabel="Close audio output menu"
            onPress={() => setIsOpen(false)}>
            <View style={styles.menu} accessibilityRole="menu">
              <Text style={styles.menuTitle}>Audio output</Text>
              {routes.map(route => {
                const isActive = route === effectiveSelected;
                return (
                  <Pressable
                    key={route}
                    onPress={() => handleSelect(route)}
                    accessibilityRole="menuitem"
                    accessibilityState={{ selected: isActive }}
                    testID={`audio-output-${route}`}
                    style={({ pressed }) => [
                      styles.menuItem,
                      isActive && styles.menuItemActive,
                      pressed && styles.menuItemPressed,
                    ]}>
                    <Text style={styles.menuItemText}>{getAudioRouteLabel(route)}</Text>
                    {isActive ? <Text style={styles.menuItemCheck}>✓</Text> : null}
                  </Pressable>
                );
              })}
            </View>
          </Pressable>
        </Modal>
      ) : null}
    </View>
  );
}

/** @param {import('../theme').ThemeColors} colors */
const createStyles = (colors: import('../theme').ThemeColors): import('../theme').ThemeColors =>
  StyleSheet.create({
    trigger: {
      alignItems: 'center',
      justifyContent: 'center',
    },
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.45)',
      alignItems: 'center',
      justifyContent: 'center',
      padding: spacing.lg,
    },
    menu: {
      width: '100%',
      maxWidth: 320,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surfaceRaised,
      padding: spacing.sm,
      gap: spacing.xs,
    },
    menuTitle: {
      color: colors.textPrimary,
      fontSize: 16,
      fontWeight: '700',
      marginBottom: spacing.xs,
    },
    menuItem: {
      borderRadius: radius.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      backgroundColor: colors.surfaceControl,
    },
    menuItemActive: {
      borderWidth: 1,
      borderColor: colors.accent,
    },
    menuItemPressed: {
      opacity: 0.85,
    },
    menuItemText: {
      color: colors.textPrimary,
      fontWeight: '600',
    },
    menuItemCheck: {
      color: colors.accent,
      fontWeight: '700',
    },
  });

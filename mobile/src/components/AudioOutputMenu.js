import { useMemo, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { AUDIO_ROUTES, getAudioRouteLabel } from '../audioRouting';
import { useThemedStyles } from '../ThemeContext';
import { radius, spacing } from '../theme';
import IconButton from './IconButton';

// Speaker and earpiece are always selectable; Bluetooth and wired headset are
// merged in only when the OS reports them as available.
const BASE_ROUTES = [AUDIO_ROUTES.SPEAKER_PHONE, AUDIO_ROUTES.EARPIECE];

function buildRouteList(available) {
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
 * @param {string[]} props.available - Device names reported by the OS.
 * @param {string|null} props.selected - Currently selected device name.
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
}) {
  const styles = useThemedStyles(createStyles);

  const [isOpen, setIsOpen] = useState(false);
  const routes = useMemo(() => buildRouteList(available), [available]);

  const effectiveSelected =
    selected || (isSpeakerEnabled ? AUDIO_ROUTES.SPEAKER_PHONE : AUDIO_ROUTES.EARPIECE);
  const currentLabel = getAudioRouteLabel(effectiveSelected);
  const currentIcon = effectiveSelected === AUDIO_ROUTES.SPEAKER_PHONE ? 'speaker' : 'speakerOff';

  const handleSelect = route => {
    setIsOpen(false);
    onSelect(route);
  };

  return (
    <>
      <IconButton
        icon={currentIcon}
        onPress={() => setIsOpen(true)}
        disabled={disabled}
        variant="default"
        size={56}
        accessibilityLabel={`Audio output: ${currentLabel}. Tap to change`}
        testID="audio-output-trigger"
      />

      <Modal
        visible={isOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setIsOpen(false)}>
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
    </>
  );
}

const createStyles = colors =>
  StyleSheet.create({
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

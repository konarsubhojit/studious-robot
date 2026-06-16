import { useMemo, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { AUDIO_ROUTES, getAudioRouteLabel } from '../audioRouting';
import { colors, radius, spacing } from '../theme';

// Speaker and earpiece are always selectable; Bluetooth and wired headset are
// merged in only when the OS reports them as available.
const BASE_ROUTES = [AUDIO_ROUTES.SPEAKER_PHONE, AUDIO_ROUTES.EARPIECE];

function buildRouteList(available) {
  const routes = [...BASE_ROUTES];
  (available || []).forEach((route) => {
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
  onOpenChange,
  disabled = false,
}) {
  const [isOpen, setIsOpen] = useState(false);
  const routes = useMemo(() => buildRouteList(available), [available]);

  const setOpen = (open) => {
    setIsOpen(open);
    onOpenChange?.(open);
  };

  const effectiveSelected =
    selected || (isSpeakerEnabled ? AUDIO_ROUTES.SPEAKER_PHONE : AUDIO_ROUTES.EARPIECE);
  const currentLabel = getAudioRouteLabel(effectiveSelected);

  const handleSelect = (route) => {
    setOpen(false);
    onSelect(route);
  };

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={`Audio output: ${currentLabel}. Tap to change`}
        accessibilityState={{ disabled, expanded: isOpen }}
        testID="audio-output-trigger"
        style={({ pressed }) => [
          styles.trigger,
          disabled && styles.triggerDisabled,
          pressed && styles.triggerPressed,
        ]}
      >
        <Text style={styles.triggerText} numberOfLines={1}>{`🔊 ${currentLabel}`}</Text>
        <Text style={styles.caret}>▾</Text>
      </Pressable>

      <Modal
        visible={isOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
      >
        <Pressable
          style={styles.backdrop}
          accessibilityLabel="Close audio output menu"
          onPress={() => setOpen(false)}
        >
          <View style={styles.menu} accessibilityRole="menu">
            <Text style={styles.menuTitle}>Audio output</Text>
            {routes.map((route) => {
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
                  ]}
                >
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

const styles = StyleSheet.create({
  trigger: {
    flex: 1,
    minHeight: 44,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    backgroundColor: colors.accentButton,
  },
  triggerDisabled: {
    opacity: 0.55,
  },
  triggerPressed: {
    opacity: 0.88,
  },
  triggerText: {
    color: colors.textOnAccent,
    fontWeight: '700',
  },
  caret: {
    color: colors.textOnAccent,
    fontWeight: '700',
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

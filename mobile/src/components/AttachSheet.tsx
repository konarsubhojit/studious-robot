import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useThemedStyles } from '../ThemeContext';
import { overlay, radius, spacing } from '../theme';
import type { ThemeColors } from '../theme';

/**
 * Bottom sheet offering the composer's attachment choices (photo / camera /
 * file). Modelled on {@link ../components/AudioOutputMenu}'s modal/backdrop
 * pattern.
 */
export default function AttachSheet({ visible, onClose, onSelect }: { visible: boolean; onClose: () => void; onSelect: (kind: 'photo' | 'camera' | 'file') => void; }) {
  const styles = useThemedStyles(createStyles);

  if (!visible) return null;

  const options: ReadonlyArray<{ kind: 'photo' | 'camera' | 'file'; label: string; emoji: string; }> = [
    { kind: 'photo', label: 'Photo', emoji: '🖼️' },
    { kind: 'camera', label: 'Camera', emoji: '📷' },
    { kind: 'file', label: 'File', emoji: '📎' },
  ];

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        style={styles.backdrop}
        accessibilityLabel="Close attachment menu"
        onPress={onClose}
        testID="chat-attach-sheet-backdrop">
        <View style={styles.sheet} accessibilityRole="menu" testID="chat-attach-sheet">
          <Text style={styles.title}>Send</Text>
          {options.map(option => (
            <Pressable
              key={option.kind}
              onPress={() => {
                onClose();
                onSelect(option.kind);
              }}
              accessibilityRole="menuitem"
              accessibilityLabel={option.label}
              testID={`chat-attach-option-${option.kind}`}
              style={({ pressed }) => [styles.option, pressed && styles.optionPressed]}>
              <Text style={styles.optionEmoji}>{option.emoji}</Text>
              <Text style={styles.optionText}>{option.label}</Text>
            </Pressable>
          ))}
        </View>
      </Pressable>
    </Modal>
  );
}

/** @param colors */
const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: overlay.scrimSoft,
      justifyContent: 'flex-end',
    },
    sheet: {
      borderTopLeftRadius: radius.lg,
      borderTopRightRadius: radius.lg,
      backgroundColor: colors.surfaceRaised,
      padding: spacing.md,
      gap: spacing.xs,
    },
    title: {
      color: colors.textSecondary,
      fontSize: 13,
      fontWeight: '700',
      marginBottom: spacing.xs,
    },
    option: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      borderRadius: radius.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
      backgroundColor: colors.surfaceControl,
    },
    optionPressed: {
      opacity: 0.85,
    },
    optionEmoji: {
      fontSize: 20,
    },
    optionText: {
      color: colors.textPrimary,
      fontWeight: '600',
      fontSize: 15,
    },
  });

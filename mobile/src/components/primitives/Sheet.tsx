import { useContext } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import useReducedMotion from '../../hooks/useReducedMotion';
import { useThemedStyles } from '../../ThemeContext';
import { elevation, overlay, radius, spacing, typography } from '../../theme';
import type { ReactNode } from 'react';
import type { ThemeColors } from '../../theme';

export type SheetProps = {
  visible: boolean;
  onClose: () => void;
  /** Heading shown above the content, and the sheet's accessible name. */
  title: string;
  /** Optional one-line explanation under the title. */
  subtitle?: string;
  children: ReactNode;
  testID?: string;
};

/**
 * Bottom-sheet container: scrim, rounded top corners, grabber, safe-area
 * bottom padding.
 *
 * `AttachSheet` and `AudioOutputMenu` each carried their own copy of this
 * modal/backdrop/scrim arrangement, at two different corner radii and with
 * only one of them padding the home-indicator inset. The People picker and the
 * in-call More menu are the third and fourth callers, so it is a primitive.
 *
 * The scrim is a labelled `Pressable`, so dismissing by tapping outside is
 * reachable without sight; `onRequestClose` covers Android's back gesture.
 */
export default function Sheet({
  visible,
  onClose,
  title,
  subtitle,
  children,
  testID,
}: SheetProps) {
  const styles = useThemedStyles(createStyles);
  // Read the context directly rather than through `useSafeAreaInsets()`: that
  // hook throws when no provider is mounted, and a sheet can legitimately be
  // rendered outside one (in a modal host, or under test). No provider simply
  // means no home-indicator inset to avoid.
  const insets = useContext(SafeAreaInsetsContext);
  const reduceMotion = useReducedMotion();
  const bottomInset = Math.max(insets?.bottom ?? 0, 0);

  if (!visible) return null;

  // The sheet still appears and still dismisses under reduced motion; it simply
  // arrives already opaque instead of fading in.
  return (
    <Modal
      visible
      transparent
      animationType={reduceMotion ? 'none' : 'fade'}
      onRequestClose={onClose}>
      <Pressable
        style={styles.backdrop}
        accessibilityRole="button"
        accessibilityLabel={`Close ${title}`}
        onPress={onClose}
        testID={testID ? `${testID}-backdrop` : undefined}>
        {/* Swallow taps on the sheet itself so they never reach the scrim. */}
        <Pressable
          style={[styles.sheet, { paddingBottom: spacing.md + bottomInset }]}
          accessibilityViewIsModal
          onPress={() => {}}
          testID={testID}>
          <View style={styles.grabber} accessibilityElementsHidden importantForAccessibility="no" />
          <Text style={styles.title} accessibilityRole="header">
            {title}
          </Text>
          {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
          {children}
        </Pressable>
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
      // The modal layer, a rung above the cards it is presented over.
      backgroundColor: colors.surfaceContainerHigh,
      paddingHorizontal: spacing.md,
      paddingTop: spacing.sm,
      gap: spacing.xs,
      maxHeight: '80%',
      ...elevation(colors.shadow).high,
    },
    grabber: {
      alignSelf: 'center',
      width: 36,
      height: 4,
      borderRadius: radius.pill,
      backgroundColor: colors.outlineVariant,
      marginBottom: spacing.sm,
    },
    title: {
      ...typography.headline,
      color: colors.onSurface,
    },
    subtitle: {
      ...typography.body,
      color: colors.onSurfaceVariant,
      marginBottom: spacing.xs,
    },
  });

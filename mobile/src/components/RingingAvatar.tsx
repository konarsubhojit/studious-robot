import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { useThemedStyles } from '../ThemeContext';
import useReducedMotion from '../hooks/useReducedMotion';
import type { ThemeColors } from '../theme';

/** Diameter of the avatar disc. */
const AVATAR_SIZE = 100;
/** Diameter of the halo at rest; large enough to read as a ring around it. */
const RING_SIZE = 144;
/** How far the halo grows at the top of the pulse. */
const RING_PEAK_SCALE = 1.2;
/**
 * The box both live in. Sized for the halo at its peak so the pulse is fully
 * contained: the ring used to be absolutely positioned inside a `flex: 1`
 * centred section, which centres on *the section* rather than on the avatar —
 * so with a name and countdown below it, the halo rendered behind the name.
 */
const RING_BOX_SIZE = Math.ceil(RING_SIZE * RING_PEAK_SCALE);

export type RingingAvatarTone = 'accent' | 'success';

/**
 * The pulsing avatar shown while a call rings, incoming or outgoing.
 *
 * Shared by both ringing screens because the ring/name collision was the same
 * bug written twice, and because a caller and a callee should be presented
 * identically — only the tone differs.
 *
 * @param initials - Up to two letters identifying the peer.
 * @param tone - `accent` for an outgoing call, `success` for an incoming one.
 */
export default function RingingAvatar({
  initials,
  tone = 'accent',
  testID,
}: {
  initials: string;
  tone?: RingingAvatarTone;
  testID?: string;
}) {
  const styles = useThemedStyles(createStyles);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const reduceMotion = useReducedMotion();

  // A never-ending pulse is exactly the kind of motion "reduce motion" is asked
  // to stop, and it is decorative: the ring conveys nothing the peer's name,
  // the countdown and the call buttons do not already say.
  useEffect(() => {
    if (reduceMotion) {
      pulseAnim.setValue(1);
      return undefined;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: RING_PEAK_SCALE,
          duration: 900,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 900,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulseAnim, reduceMotion]);

  return (
    <View style={styles.ringBox} testID={testID}>
      <Animated.View
        style={[
          styles.pulseRing,
          tone === 'success' ? styles.pulseRingSuccess : styles.pulseRingAccent,
          { transform: [{ scale: pulseAnim }] },
        ]}
        accessible={false}
      />
      <View
        style={styles.avatar}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants">
        <Text style={styles.avatarText}>{initials}</Text>
      </View>
    </View>
  );
}

/** @param colors */
const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    ringBox: {
      width: RING_BOX_SIZE,
      height: RING_BOX_SIZE,
      alignItems: 'center',
      justifyContent: 'center',
    },
    pulseRing: {
      position: 'absolute',
      width: RING_SIZE,
      height: RING_SIZE,
      borderRadius: RING_SIZE / 2,
    },
    pulseRingAccent: {
      backgroundColor: colors.accentButton,
      opacity: 0.15,
    },
    pulseRingSuccess: {
      backgroundColor: colors.success,
      opacity: 0.18,
    },
    avatar: {
      width: AVATAR_SIZE,
      height: AVATAR_SIZE,
      borderRadius: AVATAR_SIZE / 2,
      backgroundColor: colors.surfaceRaised,
      borderWidth: 2,
      borderColor: colors.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    avatarText: {
      fontSize: 36,
      fontWeight: '700',
      color: colors.textPrimary,
    },
  });

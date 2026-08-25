import { StyleSheet, Text } from 'react-native';
import { ICONS, loadVectorIcons } from '../../vectorIcons';

export type IconProps = {
  /** Semantic key from the `ICONS` map in `vectorIcons`. */
  name: string;
  size?: number;
  color: string;
  testID?: string;
};

/**
 * A single control glyph, resolved through the semantic `ICONS` map.
 *
 * Before this existed, every screen repeated the same four lines — call
 * `loadVectorIcons()`, look the key up in `ICONS`, render `<MCIcon/>` when the
 * native font is linked, fall back to `<Text>{emoji}</Text>` when it is not —
 * and several screens skipped the map entirely and hardcoded an emoji (🔍, ⚙️,
 * ✕, ‹). Emoji do not take the palette's colour, do not scale with the
 * surrounding type and read as illustrations rather than controls, so they are
 * now reachable only on the font-not-linked fallback path.
 *
 * Decorative by default (`accessibilityElementsHidden`): an icon inside a
 * labelled Pressable would otherwise be announced twice. Give the *control* an
 * `accessibilityLabel`, never the icon.
 */
export default function Icon({ name, size = 20, color, testID }: IconProps) {
  const iconDef = ICONS[name];
  const MCIcon = loadVectorIcons();

  if (iconDef && MCIcon) {
    return (
      <MCIcon
        name={iconDef.icon}
        size={size}
        color={color}
        // `react-native-vector-icons` renders a <Text>, so it lands in the
        // accessibility tree unless it is explicitly excluded.
        accessibilityElementsHidden
        importantForAccessibility="no"
        testID={testID}
      />
    );
  }

  return (
    <Text
      style={[styles.fallback, { fontSize: size, lineHeight: Math.round(size * 1.2), color }]}
      accessibilityElementsHidden
      importantForAccessibility="no"
      // The fallback is a glyph, not prose: capping the multiplier keeps it
      // inside the fixed-size control it is drawn in.
      maxFontSizeMultiplier={1.2}
      testID={testID}>
      {iconDef?.emoji ?? '•'}
    </Text>
  );
}

const styles = StyleSheet.create({
  fallback: {
    textAlign: 'center',
  },
});

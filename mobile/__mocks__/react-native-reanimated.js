/**
 * Shared jest mock for react-native-reanimated.
 *
 * Animations resolve to their target value immediately so a test can read the
 * settled result without pumping timers, and completion callbacks fire as if
 * the animation had finished.  Shared values are ref-backed so they survive
 * re-renders exactly as the real ones do.
 *
 * Lives next to `node_modules` so jest applies it automatically; a test that
 * needs stricter behaviour can still call `jest.mock` locally.
 */
const React = require('react');
const { View, Text, ScrollView } = require('react-native');

/** Layout animation descriptors are only ever compared by identity in tests. */
function createLayoutAnimation(name) {
  return {
    duration: () => name,
    delay: () => name,
    springify: () => name,
    withInitialValues: () => name,
    toString: () => name,
  };
}

const layoutAnimationNames = [
  'FadeIn',
  'FadeInDown',
  'FadeInUp',
  'FadeInLeft',
  'FadeInRight',
  'FadeOut',
  'FadeOutDown',
  'FadeOutUp',
  'FadeOutLeft',
  'FadeOutRight',
  'ZoomIn',
  'ZoomOut',
  'SlideInDown',
  'SlideOutDown',
];

const layoutAnimations = {};
for (const name of layoutAnimationNames) {
  layoutAnimations[name] = createLayoutAnimation(name);
}

module.exports = {
  __esModule: true,
  default: { View, Text, ScrollView, createAnimatedComponent: component => component },
  ...layoutAnimations,
  useSharedValue: initial => {
    const ref = React.useRef(null);
    if (ref.current === null) {
      ref.current = { value: initial };
    }
    return ref.current;
  },
  useAnimatedStyle: factory => factory(),
  useDerivedValue: factory => ({ value: factory() }),
  useAnimatedRef: () => React.useRef(null),
  withSpring: (toValue, _config, callback) => {
    callback?.(true);
    return toValue;
  },
  withTiming: (toValue, _config, callback) => {
    callback?.(true);
    return toValue;
  },
  withDelay: (_delay, animation) => animation,
  withSequence: (...animations) => animations[animations.length - 1],
  cancelAnimation: () => {},
  runOnJS: fn => fn,
  runOnUI: fn => fn,
  Easing: { linear: () => 0, ease: () => 0, out: () => 0, inOut: () => 0, bezier: () => () => 0 },
};

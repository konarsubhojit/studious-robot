/**
 * Shared jest mock for react-native-gesture-handler.
 *
 * The real package ships untranspiled ES modules that this project's
 * `transformIgnorePatterns` deliberately skips, so every test that renders a
 * gesture-driven component needs a stub.  Keeping one here — adjacent to
 * `node_modules`, so jest applies it automatically — stops that stub being
 * copy-pasted into each new test file.
 *
 * The builder records its callbacks on the gesture object under `handlers`,
 * which lets a test drive a gesture without a real touch stream.  A test that
 * needs different behaviour can still call `jest.mock` locally.
 */
const React = require('react');

function createGestureBuilder() {
  const gesture = {
    handlers: {},
    // Configuration methods are no-ops that keep the builder chainable.
    enabled() {
      return this;
    },
    minDistance() {
      return this;
    },
    activeOffsetX() {
      return this;
    },
    activeOffsetY() {
      return this;
    },
    failOffsetX() {
      return this;
    },
    failOffsetY() {
      return this;
    },
    maxPointers() {
      return this;
    },
    numberOfTaps() {
      return this;
    },
    minDuration() {
      return this;
    },
    shouldCancelWhenOutside() {
      return this;
    },
    simultaneousWithExternalGesture() {
      return this;
    },
  };
  for (const name of ['onBegin', 'onStart', 'onUpdate', 'onChange', 'onEnd', 'onFinalize']) {
    gesture[name] = function (callback) {
      this.handlers[name] = callback;
      return this;
    };
  }
  return gesture;
}

const Gesture = {
  Pan: createGestureBuilder,
  Pinch: createGestureBuilder,
  Tap: createGestureBuilder,
  LongPress: createGestureBuilder,
  Simultaneous: (...gestures) => ({ handlers: {}, gestures }),
  Race: (...gestures) => ({ handlers: {}, gestures }),
};

module.exports = {
  __esModule: true,
  Gesture,
  GestureDetector: ({ children }) => children,
  GestureHandlerRootView: ({ children, ...props }) =>
    React.createElement('GestureHandlerRootView', props, children),
};

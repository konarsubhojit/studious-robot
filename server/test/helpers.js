'use strict';

/**
 * Capture console.log output for assertions.
 *
 * Tests must call `restore()` in `t.after(...)` or a `finally` block so the
 * process-wide console implementation is always restored before later tests run.
 */
function captureConsoleLog() {
  const original = console.log;
  const lines = [];
  console.log = (...args) => {
    lines.push(args.join(' '));
  };
  return {
    lines,
    restore: () => { console.log = original; },
  };
}

module.exports = { captureConsoleLog };

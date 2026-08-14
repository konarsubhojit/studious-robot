'use strict';

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

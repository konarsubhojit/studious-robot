// @ts-check

/** @typedef {{ source: string, message: string }} StartupIssue */

/** @type {StartupIssue[]} */
const startupIssues = [];

/**
 * @param {string} source
 * @param {string} [message]
 */
export function recordStartupIssue(source, message) {
  if (!source || startupIssues.some(issue => issue.source === source)) return;
  startupIssues.push({ source, message: message || source });
}

/** @returns {StartupIssue[]} */
export function getStartupIssues() {
  return startupIssues.slice();
}

export function clearStartupIssues() {
  startupIssues.length = 0;
}

export type StartupIssue = { source: string; message: string; };

/** @type {StartupIssue[]} */
const startupIssues: StartupIssue[] = [];

/**
 * @param {string} source
 * @param {string} [message]
 */
export function recordStartupIssue(source: string, message?: string) {
  if (!source || startupIssues.some(issue => issue.source === source)) return;
  startupIssues.push({ source, message: message || source });
}

/** @returns {StartupIssue[]} */
export function getStartupIssues(): StartupIssue[] {
  return startupIssues.slice();
}

export function clearStartupIssues() {
  startupIssues.length = 0;
}

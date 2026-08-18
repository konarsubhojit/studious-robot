const startupIssues = [];

export function recordStartupIssue(source, message) {
  if (!source || startupIssues.some(issue => issue.source === source)) return;
  startupIssues.push({ source, message: message || source });
}

export function getStartupIssues() {
  return startupIssues.slice();
}

export function clearStartupIssues() {
  startupIssues.length = 0;
}

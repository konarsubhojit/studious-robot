export type StartupIssue = { source: string; message: string; };

const startupIssues: StartupIssue[] = [];

export function recordStartupIssue(source: string, message?: string) {
  if (!source || startupIssues.some(issue => issue.source === source)) return;
  startupIssues.push({ source, message: message || source });
}


export function getStartupIssues(): StartupIssue[] {
  return startupIssues.slice();
}

export function clearStartupIssues() {
  startupIssues.length = 0;
}

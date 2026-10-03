import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(thisDir, '..', '..', 'deploy', 'redeploy.sh');

interface Result {
  code: number;
  stderr: string;
  order: string[];
}

function createHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'robot-redeploy-'));
  const bin = path.join(dir, 'bin');
  const repo = path.join(dir, 'repo');
  const log = path.join(dir, 'commands.log');
  const snapshot = path.join(bin, 'snapshot');
  fs.mkdirSync(path.join(repo, 'server'), { recursive: true });
  fs.mkdirSync(bin);

  const commands: Record<string, string> = {
    sudo: `#!/bin/bash
set -eu
[ "\${1:-}" = -n ] || exit 90
shift
if [ "\${1:-}" = -u ]; then
  shift 2
  [ "\${1:-}" = -H ] && shift
  [ "\${1:-}" = bash ] && [ "\${2:-}" = -lc ] || exit 91
  script="$3"
  shift 3
  exec /bin/bash -c "$script" "$@"
fi
exec "$@"
`,
    git: `#!/bin/bash
printf 'pull\\n' >> "$COMMAND_LOG"
[ "\${FAIL_STAGE:-}" != pull ]
`,
    npm: `#!/bin/bash
case "$*" in
  ci) stage=install ;;
  'run db:migrate') stage=migrate ;;
  'prune --omit=dev') stage=prune ;;
  *) exit 92 ;;
esac
printf '%s\\n' "$stage" >> "$COMMAND_LOG"
[ "\${FAIL_STAGE:-}" != "$stage" ]
`,
    systemctl: `#!/bin/bash
printf '%s\\n' "$1" >> "$COMMAND_LOG"
case "$1" in
  restart) [ "\${FAIL_STAGE:-}" != restart ] ;;
  is-active) [ "\${FAIL_STAGE:-}" != service ] ;;
  status) [ "\${FAIL_STAGE:-}" != status ] ;;
  *) exit 93 ;;
esac
`,
    curl: `#!/bin/bash
printf 'health\\n' >> "$COMMAND_LOG"
[ "\${FAIL_STAGE:-}" != health ] || exit 1
printf '{"stateAffinity":"%s"}\\n' "\${MOCK_STATE_AFFINITY:-shared}"
`,
    jq: `#!/bin/sh
printf '%s\\n' "\${MOCK_STATE_AFFINITY:-shared}"
`,
    sleep: '#!/bin/sh\nexit 0\n',
  };

  for (const [name, content] of Object.entries(commands)) {
    fs.writeFileSync(path.join(bin, name), content, { mode: 0o755 });
  }
  fs.writeFileSync(snapshot, `#!/bin/sh\nexit 0\n`, { mode: 0o755 });

  return {
    dir,
    run(options: { failStage?: string; stateAffinity?: string } = {}): Promise<Result> {
      fs.rmSync(log, { force: true });
      return new Promise((resolve) => {
        execFile(
          '/bin/bash',
          [SCRIPT],
          {
            env: {
              ...process.env,
              PATH: `${bin}:${process.env.PATH ?? ''}`,
              COMMAND_LOG: log,
              FAIL_STAGE: options.failStage ?? '',
              MOCK_STATE_AFFINITY: options.stateAffinity ?? 'shared',
              ROBOT_REDEPLOY_REPO: repo,
              ROBOT_METRICS_SNAPSHOT: snapshot,
            },
          },
          (error, _stdout, stderr) => {
            resolve({
              code: error ? Number((error as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0,
              stderr,
              order: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [],
            });
          }
        );
      });
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

for (const [stage, expectedError] of [
  ['pull', 'pull failed'],
  ['install', 'install failed'],
  ['migrate', 'migrate failed'],
  ['prune', 'install prune failed'],
  ['restart', 'restart failed'],
  ['service', 'restart failed'],
  ['health', 'health failed'],
] as const) {
  test(`redeploy exits non-zero and names ${stage} failures`, async () => {
    const h = createHarness();
    try {
      const result = await h.run({
        failStage: stage,
      });
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, new RegExp(`redeploy: ${expectedError}`));
    } finally {
      h.cleanup();
    }
  });
}

test('redeploy prunes dev dependencies before restart and warns on sticky affinity', async () => {
  const h = createHarness();
  try {
    const result = await h.run({ stateAffinity: 'sticky' });
    assert.equal(result.code, 0, result.stderr);
    assert.ok(result.stderr.includes('warning: health stateAffinity=sticky'));
    assert.ok(result.order.indexOf('prune') < result.order.indexOf('restart'));
    assert.ok(result.order.includes('is-active'));
    assert.ok(result.order.includes('health'));
  } finally {
    h.cleanup();
  }
});

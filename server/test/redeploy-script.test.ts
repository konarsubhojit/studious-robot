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
    node: `#!/bin/bash
[ "$*" = scripts/check-pending-migrations.ts ] || exit 94
printf 'pending\\n' >> "$COMMAND_LOG"
[ "\${FAIL_STAGE:-}" != pending ]
`,
    systemctl: `#!/bin/bash
printf '%s\\n' "$1" >> "$COMMAND_LOG"
case "$1" in
  restart) [ "\${FAIL_STAGE:-}" != restart ] ;;
  is-active) [ "\${FAIL_STAGE:-}" != service ] ;;
  status) [ "\${FAIL_STAGE:-}" != status ] ;;
  start)
    [ "$*" = 'start --wait robot-deploy-metrics-probe.service' ] || exit 95
    [ "\${FAIL_STAGE:-}" != metrics ] ;;
  *) exit 93 ;;
esac
`,
    curl: `#!/bin/bash
printf 'health\\n' >> "$COMMAND_LOG"
[ "\${FAIL_STAGE:-}" != health ] || exit 1
status=ok
[ "\${FAIL_STAGE:-}" != healthStatus ] || status=starting
hydration=succeeded
[ "\${FAIL_STAGE:-}" != hydration ] || hydration=failed
printf '{"status":"%s","stateAffinity":"%s","hydration":{' "$status" "\${MOCK_STATE_AFFINITY:-shared}"
for step in users devices calls callEvents blocks accountDeletions; do
  [ "$step" = users ] || printf ','
  printf '"%s":{"status":"%s","loaded":0}' "$step" "$hydration"
done
printf '}}\\n'
`,
    sleep: '#!/bin/sh\nexit 0\n',
  };

  for (const [name, content] of Object.entries(commands)) {
    fs.writeFileSync(path.join(bin, name), content, { mode: 0o755 });
  }

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
  ['pending', 'pending migrations verification failed'],
  ['prune', 'install prune failed'],
  ['restart', 'restart failed'],
  ['service', 'restart failed'],
  ['health', 'health failed'],
  ['healthStatus', 'health failed'],
  ['hydration', 'hydration failed'],
  ['metrics', 'metrics probe failed'],
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
    assert.ok(result.order.indexOf('migrate') < result.order.indexOf('pending'));
    assert.ok(result.order.indexOf('pending') < result.order.indexOf('restart'));
    assert.ok(result.order.includes('is-active'));
    assert.ok(result.order.includes('health'));
  } finally {
    h.cleanup();
  }
});

test('pending migrations prevent a service restart', async () => {
  const h = createHarness();
  try {
    const result = await h.run({ failStage: 'pending' });
    assert.notEqual(result.code, 0);
    assert.ok(!result.order.includes('restart'));
  } finally {
    h.cleanup();
  }
});

test('deploy metrics probe requires a token and exactly HTTP 200 without writing snapshots', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'robot-deploy-probe-'));
  const probe = path.join(thisDir, '..', '..', 'deploy', 'robot-deploy-metrics-probe.sh');
  fs.writeFileSync(path.join(dir, 'curl'), `#!/bin/bash
header="$(cat)"
[ "$header" = 'x-debug-token: fixture-token' ] || exit 97
[ "$*" = '--silent --show-error --fail --connect-timeout 5 --max-time 15 --header @- --output /dev/null --write-out %{http_code} http://127.0.0.1:4173/metrics' ] || exit 98
printf '%s' "$MOCK_HTTP_STATUS"
`, { mode: 0o755 });
  try {
    for (const [token, status, expected] of [
      ['', '200', 1],
      ['fixture-token', '200', 0],
      ['fixture-token', '401', 1],
      ['fixture-token', '204', 1],
    ] as const) {
      const result = await new Promise<{ code: number; stderr: string }>(resolve => {
        execFile('/bin/bash', [probe], {
          env: { PATH: `${dir}:${process.env.PATH}`, DEBUG_API_TOKEN: token, MOCK_HTTP_STATUS: status },
        }, (error, _stdout, stderr) => resolve({ code: error ? 1 : 0, stderr }));
      });

      assert.equal(result.code, expected, result.stderr);
      assert.ok(!result.stderr.includes('fixture-token'));
      if (!token) assert.match(result.stderr, /DEBUG_API_TOKEN is not set/);
    }
    assert.deepEqual(fs.readdirSync(dir), ['curl']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('manual snapshot fails clearly before filesystem writes when its token is absent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'robot-snapshot-token-'));
  const snapshot = path.join(thisDir, '..', '..', 'deploy', 'robot-metrics-snapshot.sh');
  try {
    const result = await new Promise<{ code: number; stderr: string }>(resolve => {
      execFile('/bin/bash', [snapshot, 'manual'], {
        env: {
          PATH: process.env.PATH,
          ROBOT_METRICS_ENV_FILE: path.join(dir, 'absent'),
          ROBOT_METRICS_LOG_DIR: dir,
        },
      }, (error, _stdout, stderr) => resolve({ code: error ? 1 : 0, stderr }));
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /DEBUG_API_TOKEN is not set/);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

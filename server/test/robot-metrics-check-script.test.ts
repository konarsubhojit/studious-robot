/**
 * Tests for `deploy/robot-metrics-check.sh` severity classification.
 *
 * `curl` is replaced with a stub that prints a fixture `/metrics` body, so the
 * suite needs no running server and no real debug token. `jq` is the real
 * binary, since the checks themselves are jq programs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/index.ts';
import { closeTestServer, listenOnRandomPort } from './helpers.ts';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(thisDir, '..', '..', 'deploy', 'robot-metrics-check.sh');

type Counters = Record<string, number>;

/**
 * A healthy production reading: more calls ended than reached `in_call`
 * (cancelled/busy calls still end), and more delivery marks issued than
 * messages persisted (online delivery and the later read both mark).
 */
function healthyMetrics(counters: Counters = {}) {
  const merged: Counters = {
    calls_initiated: 20,
    calls_accepted: 11,
    calls_in_call: 11,
    calls_ended: 19,
    calls_ended_for_initiated: 19,
    calls_cancelled: 7,
    calls_busy: 2,
    messages_persisted_total: 24,
    messages_delivery_marks_issued_total: 32,
    db_queries_total: 512,
    ...counters,
  };
  return {
    metricScopes: {
      counters: {
        calls_initiated: 'process-local-initiated-cohort',
        calls_ended_for_initiated: 'process-local-initiated-cohort',
      },
    },
    counters: merged,
    histograms: {},
    derived: {
      call_completion_rate:
        merged.calls_in_call > 0
          ? Number((merged.calls_ended / merged.calls_in_call).toFixed(4))
          : null,
      messages_delivery_marking_gap:
        merged.messages_persisted_total - merged.messages_delivery_marks_issued_total,
    },
    dbQueries: [],
  };
}

interface Harness {
  dir: string;
  logDir: string;
  run: (metrics: unknown) => Promise<{ code: number; stderr: string; checks: string[] }>;
  cleanup: () => void;
}

function createHarness(): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'robot-metrics-check-'));
  const logDir = path.join(dir, 'logs');
  const envFile = path.join(dir, 'env');
  const fixture = path.join(dir, 'metrics.json');
  fs.writeFileSync(envFile, 'DEBUG_API_TOKEN=stub-token\n');
  fs.writeFileSync(path.join(dir, 'curl'), `#!/bin/sh\ncat ${JSON.stringify(fixture)}\n`, {
    mode: 0o755,
  });

  return {
    dir,
    logDir,
    run(metrics) {
      fs.writeFileSync(fixture, JSON.stringify(metrics));
      return new Promise((resolve) => {
        execFile(
          '/bin/bash',
          [SCRIPT],
          {
            env: {
              PATH: `${dir}:${process.env.PATH ?? ''}`,
              ROBOT_METRICS_LOG_DIR: logDir,
              ROBOT_METRICS_ENV_FILE: envFile,
            },
          },
          (error, _stdout, stderr) => {
            const checkLog = path.join(logDir, 'checks.log');
            const checks = fs.existsSync(checkLog)
              ? fs.readFileSync(checkLog, 'utf8').trim().split('\n')
              : [];
            const exitCode = (error as (NodeJS.ErrnoException & { code?: number }) | null)?.code;
            resolve({ code: error ? Number(exitCode ?? 1) : 0, stderr, checks });
          }
        );
      });
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function lastSnapshot(logDir: string) {
  const lines = fs.readFileSync(path.join(logDir, 'snapshots.jsonl'), 'utf8').trim().split('\n');
  return JSON.parse(lines.at(-1) ?? '{}') as { restartMarker: string; reset: boolean };
}

/** Strip the leading timestamp from a `checks.log` line. */
function body(line: string): string {
  return line.replace(/^\S+ /, '');
}

test('a healthy server with completion rate above 1 and a negative marking gap is OK', async () => {
  const h = createHarness();
  try {
    const metrics = healthyMetrics();
    assert.ok(metrics.derived.call_completion_rate !== null);
    assert.ok(metrics.derived.call_completion_rate > 1);
    const result = await h.run(metrics);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.checks.map(body), ['OK calls=20 msgs=24']);
  } finally {
    h.cleanup();
  }
});

test('hydrated or remote call endings exceeding local initiations are not an anomaly', async () => {
  const h = createHarness();
  try {
    const metrics = healthyMetrics({ calls_initiated: 1, calls_ended: 331, calls_ended_for_initiated: 1 });
    const result = await h.run(metrics);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.checks.map(body), ['OK calls=1 msgs=24']);
    const legacy = { ...metrics, metricScopes: undefined };
    const legacyResult = await h.run(legacy);
    assert.equal(legacyResult.code, 0, legacyResult.stderr);
    assert.ok(!legacyResult.checks.some(line => line.includes('ANOMALY')));
  } finally {
    h.cleanup();
  }
});

test('same-cohort endings exceeding initiations are a genuine anomaly', async () => {
  const h = createHarness();
  try {
    const result = await h.run(healthyMetrics({ calls_ended_for_initiated: 21 }));
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.checks.map(body), ['ANOMALY calls_ended_for_initiated_exceeds_calls_initiated']);
  } finally {
    h.cleanup();
  }
});

test('fewer delivery marks than persisted messages is a WARN, not an ANOMALY', async () => {
  const h = createHarness();
  try {
    const result = await h.run(healthyMetrics({ messages_delivery_marks_issued_total: 20 }));
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.checks.map(body), ['WARN delivery_marking_gap=4']);
  } finally {
    h.cleanup();
  }
});

test('an idle process with all-zero counters keeps a stable restart marker', async () => {
  const h = createHarness();
  try {
    const idle = healthyMetrics({
      calls_initiated: 0,
      calls_accepted: 0,
      calls_in_call: 0,
      calls_ended: 0,
      calls_ended_for_initiated: 0,
      calls_cancelled: 0,
      calls_busy: 0,
      messages_persisted_total: 0,
      messages_delivery_marks_issued_total: 0,
      db_queries_total: 0,
    });
    await h.run(idle);
    const first = lastSnapshot(h.logDir);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const result = await h.run(idle);
    const second = lastSnapshot(h.logDir);

    assert.deepEqual(result.checks.map(body), ['OK calls=0 msgs=0', 'OK calls=0 msgs=0']);
    assert.equal(second.reset, false);
    assert.equal(second.restartMarker, first.restartMarker);
  } finally {
    h.cleanup();
  }
});

test('a restarted all-zero call and message sample is RESET with non-zero db queries', async () => {
  const h = createHarness();
  try {
    await h.run(healthyMetrics());
    const result = await h.run(
      healthyMetrics({
        calls_initiated: 0,
        calls_accepted: 0,
        calls_in_call: 0,
        calls_ended: 0,
        calls_ended_for_initiated: 0,
        calls_cancelled: 0,
        calls_busy: 0,
        messages_persisted_total: 0,
        messages_delivery_marks_issued_total: 0,
        db_queries_total: 3,
      })
    );

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.checks.length, 2);
    assert.match(
      body(result.checks[1]),
      /^RESET restartMarker=\S+ reason=calls_initiated_decreased,messages_persisted_total_decreased,db_queries_total_decreased$/
    );
    assert.equal(lastSnapshot(h.logDir).reset, true);
  } finally {
    h.cleanup();
  }
});

test('missing token fails clearly even without a writable log directory', async () => {
  const h = createHarness();
  try {
    fs.writeFileSync(path.join(h.dir, 'env'), '');
    fs.writeFileSync(h.logDir, 'not a directory');
    const result = await h.run(healthyMetrics());
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /FAIL DEBUG_API_TOKEN_not_set/);
    assert.deepEqual(result.checks, []);
  } finally {
    h.cleanup();
  }
});

test('current expanded metrics shape is accepted but invalid shapes fail explicitly', async () => {
  const h = createHarness();
  try {
    const result = await h.run({ ...healthyMetrics(), devices: { total: 6 }, callQuality: null });
    assert.equal(result.code, 0, result.stderr);
    for (const invalid of [null, [], { counters: {}, histograms: {}, derived: {}, dbQueries: {} }]) {
      const failed = await h.run(invalid);
      assert.notEqual(failed.code, 0);
      assert.match(failed.checks.at(-1) ?? '', /FAIL metrics_invalid_json/);
    }
  } finally {
    h.cleanup();
  }
});

test('checker reports OK against the live authenticated metrics route', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'robot-live-metrics-'));
  const previousToken = process.env.DEBUG_API_TOKEN;
  process.env.DEBUG_API_TOKEN = 'live-fixture-token';
  const server = createServer();
  const port = await listenOnRandomPort(server.httpServer);
  try {
    const result = await new Promise<{ code: number; stderr: string }>(resolve => {
      execFile('/bin/bash', [SCRIPT], {
        env: {
          PATH: process.env.PATH,
          DEBUG_API_TOKEN: 'live-fixture-token',
          ROBOT_METRICS_ENV_FILE: path.join(dir, 'absent-env'),
          ROBOT_METRICS_LOG_DIR: dir,
          ROBOT_METRICS_URL: `http://127.0.0.1:${port}/metrics`,
        },
      }, (error, _stdout, stderr) => resolve({ code: error ? 1 : 0, stderr }));
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(fs.readFileSync(path.join(dir, 'checks.log'), 'utf8'), /OK calls=0 msgs=0/);
    assert.ok(!fs.readFileSync(path.join(dir, 'checks.log'), 'utf8').includes('ANOMALY'));
  } finally {
    await closeTestServer(server);
    if (previousToken === undefined) delete process.env.DEBUG_API_TOKEN;
    else process.env.DEBUG_API_TOKEN = previousToken;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

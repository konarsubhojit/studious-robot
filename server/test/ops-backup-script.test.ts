/**
 * Tests for `ops/wetalk-backup.sh`, specifically the shrink guard that
 * compares the new encrypted dump against the newest encrypted object already
 * in the bucket.
 *
 * The guard fails open — it degrades to the static `MIN_SIZE` floor and only
 * warns — so a broken lookup is invisible in the journal until the day a
 * truncated dump overwrites a good one.  Objects are keyed
 * `pg/%Y/%m/%d/%H%M%SZ.dump.age`, so the previous dump normally lives under a
 * *different* date directory than the run looking for it.
 *
 * Every external binary the script calls (`pg_dump`, `pg_restore`, `age`, the
 * OCI CLI) is replaced with a stub, so the suite needs no database, no bucket
 * and no credentials.  The `oci os object list` stub reproduces the real
 * CLI's pretty-printed, multi-line JSON.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(thisDir, '..', '..', 'ops', 'wetalk-backup.sh');

interface StoredObject {
  name: string;
  size: number;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function writeStub(file: string, body: string): void {
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

/**
 * Run the backup script against stub binaries.
 *
 * @param objects   what `oci os object list` reports in the bucket
 * @param plainSize bytes `pg_dump` produces
 * @param encSize   bytes `age` produces
 */
function runBackup(
  objects: StoredObject[],
  plainSize: number,
  encSize: number
): Promise<RunResult & { uploaded: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wetalk-backup-'));
  const uploadLog = path.join(dir, 'uploaded.txt');
  const envFile = path.join(dir, 'env');
  fs.writeFileSync(
    envFile,
    'DATABASE_URL=postgres://stub/stub\nBACKUP_AGE_RECIPIENT=age1stubrecipient\n'
  );

  // The real CLI pretty-prints one JSON object per listed entry across several
  // lines; the script must cope with that, not with a single-line projection.
  const listingFile = path.join(dir, 'listing.json');
  fs.writeFileSync(listingFile, `${JSON.stringify({ data: objects }, null, 2)}\n`);
  writeStub(
    path.join(dir, 'oci'),
    [
      'case "$*" in',
      `  *"object list"*) cat ${JSON.stringify(listingFile)} ;;`,
      `  *"object put"*) printf '%s\\n' "$*" >> ${JSON.stringify(uploadLog)} ;;`,
      '  *) echo "unexpected oci invocation: $*" >&2; exit 64 ;;',
      'esac',
    ].join('\n')
  );
  writeStub(path.join(dir, 'pg_dump'), `head -c ${plainSize} /dev/zero`);
  writeStub(path.join(dir, 'pg_restore'), 'exit 0');
  // age is called as: age -r <recipient> -o <out> <in>
  writeStub(path.join(dir, 'age'), `head -c ${encSize} /dev/zero > "$4"`);

  return new Promise((resolve) => {
    execFile(
      '/bin/bash',
      [SCRIPT],
      {
        env: {
          PATH: `${dir}:${process.env.PATH ?? ''}`,
          HOME: dir,
          BACKUP_ENV_FILE: envFile,
          OCI_BIN: path.join(dir, 'oci'),
          AGE_BIN: path.join(dir, 'age'),
        },
      },
      (error, stdout, stderr) => {
        const uploaded = fs.existsSync(uploadLog) ? fs.readFileSync(uploadLog, 'utf8') : '';
        const exitCode = (error as (NodeJS.ErrnoException & { code?: number }) | null)?.code;
        fs.rmSync(dir, { recursive: true, force: true });
        resolve({ code: error ? Number(exitCode ?? 1) : 0, stdout, stderr, uploaded });
      }
    );
  });
}

test('previous dump under an earlier date directory arms the shrink guard', async () => {
  const result = await runBackup(
    [
      { name: 'pg/2026/09/23/161616Z.dump.age', size: 141226 },
      { name: 'pg/2026/09/24/000452Z.dump.age', size: 144106 },
    ],
    200000,
    40000
  );

  assert.equal(result.code, 1, 'a dump under half the previous size must abort');
  assert.match(result.stderr, /encrypted dump shrank too much/);
  assert.match(result.stderr, /previous 144106/, 'the newest .age object is the baseline');
  assert.doesNotMatch(result.stderr, /no previous encrypted dump/);
  assert.equal(result.uploaded, '', 'nothing may be uploaded once the guard trips');
});

test('a dump within the shrink threshold is uploaded', async () => {
  const result = await runBackup(
    [{ name: 'pg/2026/09/23/161616Z.dump.age', size: 141226 }],
    200000,
    140000
  );

  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /no previous encrypted dump/);
  assert.match(result.uploaded, /pg\/\d{4}\/\d{2}\/\d{2}\/\d{6}Z\.dump\.age/);
});

test('legacy plaintext objects are not used as a baseline', async () => {
  const result = await runBackup([{ name: 'pg/2026/09/01/000000Z.dump', size: 1100000 }], 200000, 140000);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /no previous encrypted dump/);
  assert.match(result.uploaded, /\.dump\.age/);
});

test('the static MIN_SIZE floor still rejects a tiny plaintext dump', async () => {
  const result = await runBackup([], 1000, 900);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /dump is too small/);
});

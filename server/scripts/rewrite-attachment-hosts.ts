/**
 * Rewrite legacy attachment hosts in `messages.attachment.url`.
 *
 * `R2_PUBLIC_BASE_URL` changes over a deployment's life (the bucket's
 * `r2.dev` URL, then a custom domain), and every message already sent keeps
 * the base URL of its day. `GET /attachments/download` resolves those older
 * generations by key path, so nothing is broken without this script — it
 * exists for operators who would rather have the rows normalised on today's
 * base URL than carry two generations forever.
 *
 * Only the host/base-URL part is rewritten: the key path underneath
 * (`chatblobs/<scope>/<uuid>.<ext>`) is identical across generations and is
 * what identifies the object, so a row either matches that shape and is
 * rewritten in place, or is left alone.
 *
 * Usage:
 *   # Dry run (default) — reports what would change and writes nothing.
 *   DATABASE_URL_DIRECT=postgres://... node scripts/rewrite-attachment-hosts.ts
 *   # Apply, inside a single transaction.
 *   DATABASE_URL_DIRECT=postgres://... node scripts/rewrite-attachment-hosts.ts --apply
 *
 * Prefer `DATABASE_URL_DIRECT` so the rewrite uses an unpooled connection.
 * `R2_PUBLIC_BASE_URL` must be set to the *current* base URL — it is the
 * target every rewritten row is pointed at.
 */

import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';

import { ATTACHMENT_PATH_PREFIX } from '../../shared/index.ts';
import { attachmentKeyFromUrl, loadR2Config } from '../src/attachments.ts';

type RewriteClient = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; }>;
  release: () => void;
};

type RewritePool = {
  connect: () => Promise<RewriteClient>;
  end: () => Promise<void>;
};

export type RewriteSummary = {
  scanned: number;
  rewritten: number;
  alreadyCurrent: number;
  unresolved: number;
  applied: boolean;
};

/**
 * Rewrite every attachment URL that resolves to a managed key but is not
 * already on `config.publicBaseUrl`.
 *
 * The scan and the updates share one transaction, so an `--apply` run either
 * normalises every row it saw or leaves the table exactly as it found it.
 */
export async function rewriteAttachmentHosts(
  pool: RewritePool,
  { config, apply = false }: {
    config: NonNullable<ReturnType<typeof loadR2Config>>;
    apply?: boolean;
  }
): Promise<RewriteSummary> {
  const summary: RewriteSummary = {
    scanned: 0,
    rewritten: 0,
    alreadyCurrent: 0,
    unresolved: 0,
    applied: apply,
  };
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT "message_id", "attachment"->>'url' AS url
         FROM "messages"
        WHERE "attachment" IS NOT NULL
          AND "attachment"->>'url' LIKE $1`,
      [`%/${ATTACHMENT_PATH_PREFIX}/%`]
    );

    for (const row of rows) {
      summary.scanned += 1;
      const storedUrl: string = row.url;
      const key = attachmentKeyFromUrl(config, storedUrl);
      if (!key) {
        // A host this deployment never published under: never rewritten,
        // because there is no evidence the object is ours.
        summary.unresolved += 1;
        console.warn(
          `[rewrite-attachment-hosts] messageId=${row.message_id} left alone: ` +
            `unresolvable host=${safeHost(storedUrl)}`
        );
        continue;
      }
      const target = `${config.publicBaseUrl}/${key
        .split('/')
        .map(encodeURIComponent)
        .join('/')}`;
      if (target === storedUrl) {
        summary.alreadyCurrent += 1;
        continue;
      }
      summary.rewritten += 1;
      if (apply) {
        await client.query(
          `UPDATE "messages"
              SET "attachment" = jsonb_set("attachment", '{url}', to_jsonb($2::text), false)
            WHERE "message_id" = $1`,
          [row.message_id, target]
        );
      }
    }

    // A dry run still runs inside the transaction; rolling it back keeps the
    // two modes structurally identical instead of two different code paths.
    await client.query(apply ? 'COMMIT' : 'ROLLBACK');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  console.log(
    `[rewrite-attachment-hosts] ${apply ? 'applied' : 'dry run'}: ` +
      `scanned=${summary.scanned} rewritten=${summary.rewritten} ` +
      `alreadyCurrent=${summary.alreadyCurrent} unresolved=${summary.unresolved}`
  );
  if (!apply && summary.rewritten > 0) {
    console.log('[rewrite-attachment-hosts] re-run with --apply to write these changes.');
  }
  return summary;
}

/** The host of a stored URL, so a summary never prints a full user URL. */
function safeHost(url: string): string {
  try {
    return new URL(url).host || 'unparseable';
  } catch {
    return 'unparseable';
  }
}

async function main() {
  const rawDatabaseUrl = process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL;

  if (!rawDatabaseUrl) {
    console.error('Set DATABASE_URL_DIRECT (or DATABASE_URL) before rewriting attachment hosts.');
    process.exit(1);
  }

  const config = loadR2Config();
  if (!config) {
    console.error(
      'Set the R2 configuration (R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, ' +
        'R2_PUBLIC_BASE_URL) so the current base URL is known.'
    );
    process.exit(1);
    return;
  }

  const apply = process.argv.includes('--apply');
  const pool = new Pool({ connectionString: rawDatabaseUrl, max: 1 });

  try {
    await rewriteAttachmentHosts(pool as unknown as RewritePool, { config, apply });
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

import { withDatabase } from './localDatabase';

export type CachedResource<T> = { value: T; updatedAt: number };
const MAX_DIRECTORY_QUERIES = 30;
const directoryVersions = new Map<string, number>();
export function directoryVersion(scope: string): number {
  return directoryVersions.get(scope) ?? 0;
}

export async function readResource<T>(scope: string, key: string): Promise<CachedResource<T> | null> {
  if (!scope) return null;
  return withDatabase(async db => {
    const { rows } = await db.execute(
      'SELECT payload, updated_at FROM resource_cache WHERE scope = ? AND key = ?', [scope, key]);
    if (!rows.length) return null;
    return { value: JSON.parse(String(rows[0].payload)) as T, updatedAt: Number(rows[0].updated_at) };
  });
}

export async function writeResource(scope: string, key: string, value: unknown, version?: number): Promise<void> {
  if (!scope) return;
  await withDatabase(async db => {
    if (version !== undefined && version !== directoryVersion(scope)) return;
    await db.executeBatch([
      [`INSERT INTO resource_cache(scope, key, payload, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(scope, key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
      [scope, key, JSON.stringify(value), Date.now()]],
      [`DELETE FROM resource_cache WHERE scope = ? AND key LIKE 'directory:%' AND key NOT IN (
        SELECT key FROM resource_cache WHERE scope = ? AND key LIKE 'directory:%'
        ORDER BY updated_at DESC, key LIMIT ?)`, [scope, scope, MAX_DIRECTORY_QUERIES]],
    ]);
  });
}

export async function invalidateDirectory(scope: string): Promise<void> {
  if (!scope) return;
  directoryVersions.set(scope, directoryVersion(scope) + 1);
  await withDatabase(async db => {
    await db.execute("DELETE FROM resource_cache WHERE scope = ? AND key LIKE 'directory:%'", [scope]);
  });
}

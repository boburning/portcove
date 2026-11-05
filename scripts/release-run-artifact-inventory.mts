import { isRecord } from "./runtime-values.mts";

/** Complete bounded data inventory only; transport and producer authority remain with callers. */
export function inspectCompleteRunArtifactInventory(raw: unknown) {
  if (
    !isRecord(raw) ||
    !Number.isSafeInteger(raw.total_count) ||
    Number(raw.total_count) < 0 ||
    Number(raw.total_count) > 400 ||
    !Array.isArray(raw.artifacts) ||
    raw.artifacts.length !== raw.total_count
  )
    throw new Error("artifact inventory incomplete");
  const ids = new Set<number>();
  const artifacts: Record<string, unknown>[] = [];
  for (const row of raw.artifacts) {
    if (
      !isRecord(row) ||
      !Number.isSafeInteger(row.id) ||
      Number(row.id) < 1 ||
      ids.has(Number(row.id))
    )
      throw new Error("artifact inventory duplicates identity");
    ids.add(Number(row.id));
    artifacts.push(row);
  }
  return { total_count: artifacts.length, artifacts };
}

/** Shared pure page validation; source-specific budgets stay with each reader. */
function runArtifactPages() {
  const found: unknown[] = [];
  let total: number | undefined;
  return (body: unknown) => {
    if (
      !isRecord(body) ||
      !Array.isArray(body.artifacts) ||
      body.artifacts.length > 100 ||
      !Number.isSafeInteger(body.total_count) ||
      Number(body.total_count) < 0 ||
      Number(body.total_count) > 400
    )
      throw new Error("artifact inventory incomplete");
    total ??= Number(body.total_count);
    if (total !== body.total_count) throw new Error("artifact inventory changed");
    const rows: unknown[] = body.artifacts;
    found.push(...rows);
    inspectCompleteRunArtifactInventory({ total_count: found.length, artifacts: found });
    if (found.length === total)
      return inspectCompleteRunArtifactInventory({ total_count: total, artifacts: found });
    if (!rows.length || found.length > total) throw new Error("artifact inventory omitted records");
    return null;
  };
}

/** Retained synchronous release readers; retired as their owning callers migrate. */
export function readCompleteRunArtifactInventory(readPage: (page: number) => unknown) {
  const append = runArtifactPages();
  for (let page = 1; page <= 4; page++) {
    const result = append(readPage(page));
    if (result) return result;
  }
  throw new Error("artifact inventory omitted records");
}

/** Await each page and validate its identities before admitting the next read. */
export async function readCompleteRunArtifactInventoryAsync(
  readPage: (page: number) => Promise<unknown>,
) {
  const append = runArtifactPages();
  for (let page = 1; page <= 4; page++) {
    const result = append(await readPage(page));
    if (result) return result;
  }
  throw new Error("artifact inventory omitted records");
}

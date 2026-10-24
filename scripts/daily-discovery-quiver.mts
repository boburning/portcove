import { observationHash } from "./upstream-observer.mts";
import { isRecord, errorMessage } from "./runtime-values.mts";
import type { CollectedSource, SourceContext } from "./daily-discovery-sources.mts";

const origin = "https://api.quiverlauncher.com";
const feeds = ["apps", "release-status"] as const;

// App IDs survive game-title changes and repository transfers. Repository names
// are provenance/research hints, never a replacement for game + implementation.
export function collectQuiver(c: SourceContext): CollectedSource {
  const collected_at = new Date().toISOString();
  const result: CollectedSource = {
    id: "quiver-api",
    status: "inaccessible",
    evidence: `${origin}/api/v1/apps?limit=100&sort=added`,
    next_page: null,
    truncated: false,
    records: [],
    collected_at,
    cached_releases: "Discovery hints; refresh official upstream before intake or qualification",
  };
  const snapshots = new Map<string, Map<string, Record<string, unknown>>>();
  let savedPages = 0;
  try {
    for (const feed of feeds) {
      const entries = new Map<string, Record<string, unknown>>();
      const cursors = new Set<string>();
      let cursor: string | null = null;
      let page = 0;
      for (;;) {
        const url = new URL(`/api/v1/${feed}`, origin);
        url.searchParams.set("limit", "100");
        if (feed === "apps") url.searchParams.set("sort", "added");
        if (cursor !== null) url.searchParams.set("cursor", cursor);
        const response = c.http.request("GET", url.href);
        c.save(`quiver-${feed}-${++page}`, {
          url: url.href,
          collected_at,
          status: response.status,
          text: response.text,
        });
        savedPages++;
        if (response.status !== 200) throw new Error(`Quiver ${feed} HTTP ${response.status}`);
        const data: unknown = JSON.parse(response.text);
        if (!isRecord(data) || !Array.isArray(data.items) || typeof data.isDone !== "boolean")
          throw new Error(`Malformed Quiver ${feed} page`);
        for (const item of data.items) {
          if (!isRecord(item) || typeof item.id !== "string" || !item.id)
            throw new Error(`Missing Quiver ${feed} app identity`);
          const previous = entries.get(item.id);
          if (previous && observationHash(previous) !== observationHash(item))
            throw new Error(`Quiver ${feed} identity changed during pagination: ${item.id}`);
          entries.set(item.id, item);
        }
        if (data.isDone) {
          if (data.nextCursor !== null) throw new Error(`Contradictory Quiver ${feed} completion`);
          break;
        }
        if (
          typeof data.nextCursor !== "string" ||
          !data.nextCursor ||
          cursors.has(data.nextCursor) ||
          data.items.length === 0
        )
          throw new Error(`Quiver ${feed} cursor failed to advance`);
        cursors.add(data.nextCursor);
        cursor = data.nextCursor;
      }
      snapshots.set(feed, entries);
    }
    const apps = snapshots.get("apps")!;
    const releases = snapshots.get("release-status")!;
    if (apps.size !== releases.size || [...apps.keys()].some((id) => !releases.has(id)))
      throw new Error("Quiver app/release-status identity sets disagree");
    const joined = [...apps]
      .map(([id, app]) => {
        const release = releases.get(id)!;
        if (
          typeof app.name !== "string" ||
          !app.name ||
          typeof app.projectId !== "string" ||
          !app.projectId ||
          typeof app.projectName !== "string" ||
          !app.projectName ||
          !Array.isArray(app.games) ||
          app.games.some(
            (game: unknown) =>
              !isRecord(game) ||
              typeof game.id !== "string" ||
              !game.id ||
              typeof game.title !== "string" ||
              !game.title,
          ) ||
          (app.catalogId !== undefined && release.catalogId !== app.catalogId) ||
          typeof release.repository !== "string" ||
          !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(release.repository)
        )
          throw new Error(`Malformed Quiver app/repository provenance: ${id}`);
        // Engagement and observation clocks do not describe an implementation change.
        const {
          reviewCount: _reviews,
          reportBroken: _broken,
          reportIssues: _issues,
          recommended: _recommended,
          ...facts
        } = app;
        return { id, app: facts, release };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
    c.save("quiver-current", { collected_at, feeds: [...feeds], entries: joined });
    result.records = joined.map((entry) => ({
      key: entry.id,
      fingerprint: observationHash(entry),
    }));
    result.status = "complete";
    result.pages = savedPages;
    result.entries = joined.length;
  } catch (error) {
    result.status = savedPages ? "partial" : "inaccessible";
    result.error = errorMessage(error);
    result.pages = savedPages;
    // Partial feeds cannot replace the last complete checkpoint or delete records.
  }
  return result;
}

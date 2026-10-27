import {
  DiscoveryPrimaryReads,
  discoveryNextPage,
  DiscoveryCheckpointInterrupted,
} from "./discovery-primary-progress.mts";
import type { DiscoveryPrimaryProgress } from "./discovery-primary-progress.mts";
import { GitHubApiClient, GitHubApiError } from "./github-api.mts";
import { readFileSync } from "node:fs";
import { observationHash } from "./upstream-observer.mts";
import { releaseFingerprint } from "./discovery-checkpoint.mts";
import type { DiscoveryCheckpoint } from "./discovery-checkpoint.mts";
import { readDiscoveryReport } from "./discovery-artifact.mts";
import { isRecord, errorMessage } from "./runtime-values.mts";
import { collectQuiver } from "./daily-discovery-quiver.mts";
import { parseRecompFeed, parseRecompManifest } from "./discovery-ecosystems.mts";
import type { DiscoveryBudget, createDiscoveryTransport } from "./discovery-budget.mts";
export interface CollectedSource {
  id: string;
  status: "complete" | "partial" | "inaccessible";
  evidence: string;
  next_page: null;
  truncated: boolean;
  records: { key: string; fingerprint: string }[];
  [key: string]: unknown;
}
const rec = (v: unknown): Record<string, unknown> => {
  if (!isRecord(v)) throw new Error("Malformed provider object");
  return v;
};
const str = (v: unknown) => {
  if (typeof v !== "string" || !v) throw new Error("Missing provider text");
  return v;
};
export const repoName = (v: unknown) => {
  const s = str(v);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(s))
    throw new Error("Invalid upstream repository");
  return s;
};
export interface SourceContext {
  api: GitHubApiClient;
  budget: DiscoveryBudget;
  http: ReturnType<typeof createDiscoveryTransport>;
  save: (name: string, value: unknown) => void;
  primaryProgress?: DiscoveryPrimaryProgress;
  acceptSource?: (source: CollectedSource) => void;
}
export function collectRecompBoardSource(
  c: Pick<SourceContext, "http" | "save">,
  known: DiscoveryCheckpoint,
): CollectedSource {
  const url = "https://recomp.fyi/feed.xml";
  const response = c.http.request("GET", url);
  c.save("recomp-board-feed", response);
  if (response.status !== 200) throw new Error("recomp.board Atom feed unavailable");
  const leads = parseRecompFeed(response.text);
  c.save("recomp-board-leads", leads);
  const oldest = leads.map((lead) => lead.updated).sort()[0]!;
  const previous = known.sources["recomp-board-feed"];
  const gap = previous && Date.parse(oldest) > Date.parse(previous.completed_at);
  return {
    id: "recomp-board-feed",
    status: gap ? "partial" : "complete",
    evidence: url,
    next_page: null,
    truncated: false,
    snapshot_kind: "rolling-feed",
    records: leads.map((lead) => ({ key: lead.key, fingerprint: observationHash(lead) })),
    coverage:
      "Entire currently published Atom feed only; no historical table completeness or deletion claim",
    oldest_published_entry: oldest,
    ...(gap
      ? {
          next_action:
            "Feed no longer overlaps the last successful scan; reconcile the missing interval from primary sources before resetting this source checkpoint",
        }
      : {}),
    provenance: "recomp.board Atom feed; discovery hints require direct upstream research",
  };
}
function list(c: SourceContext, endpoint: string, label: string) {
  const records: unknown[] = [];
  const identities = new Set<unknown>();
  let next: string | null = endpoint;
  while (next) {
    const response = c.api.request("GET", next);
    if (!Array.isArray(response.body)) throw new Error(`${label} response is incomplete`);
    for (const value of response.body) {
      const id = rec(value).id;
      if (!Number.isSafeInteger(id) || Number(id) < 1 || identities.has(id))
        throw new Error(`${label} contains missing or duplicate identities`);
      identities.add(id);
      records.push(value);
    }
    next = discoveryNextPage(response, endpoint, next);
  }
  return records;
}
function metadata(c: SourceContext, repo: string) {
  const meta = rec(c.api.request("GET", `repos/${repoName(repo)}`).body);
  repoName(meta.full_name);
  if (typeof meta.id !== "number") throw new Error("Missing provider repository ID");
  return meta;
}
function commit(c: SourceContext, meta: Record<string, unknown>) {
  return str(
    rec(
      rec(
        c.api.request(
          "GET",
          `repos/${str(meta.full_name)}/git/ref/heads/${encodeURIComponent(str(meta.default_branch))}`,
        ).body,
      ).object,
    ).sha,
  );
}
function content(c: SourceContext, repo: string, file: string, ref: string) {
  const parts = file.split("/");
  if (
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        part.includes("\\") ||
        Array.from(part).some((c) => c.charCodeAt(0) < 32),
    )
  )
    throw new Error("Unsafe registry source path");
  const encoded = parts.map(encodeURIComponent).join("/");
  const blob = rec(
    c.api.request("GET", `repos/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`).body,
  );
  return {
    blob: str(blob.sha),
    data: JSON.parse(Buffer.from(str(blob.content), "base64").toString("utf8")) as unknown,
    evidence: `https://github.com/${repo}/blob/${ref}/${file}`,
  };
}
const entryKey = (v: Record<string, unknown>) =>
  `${typeof v.repository === "string" ? v.repository : "unknown"}/${str(v.folderName ?? v.name)}/${typeof v.project === "string" ? v.project : ""}`
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9:/_.-]/gu, "-")
    .slice(0, 240);
export function collectDiscoverySources(
  c: SourceContext,
  known: DiscoveryCheckpoint,
): CollectedSource[] {
  const result: CollectedSource[] = [];
  const accept = (source: CollectedSource) => {
    result.push(source);
    c.acceptSource?.(source);
  };
  const queues: {
    jobs: { id: string; evidence: string; run: () => void }[];
    finish: () => void;
  }[] = [];
  const now = c.budget.now();
  const due = (changed: boolean, checked: string) =>
    changed || !checked || now - Date.parse(checked) >= 7 * 86400000;
  const fail = (id: string, evidence: string, error: unknown) =>
    accept({
      id,
      status: "inaccessible",
      evidence,
      next_page: null,
      truncated: false,
      records: [],
      error: errorMessage(error),
    });
  try {
    accept(collectQuiver(c));
  } catch (error) {
    fail("quiver", "https://github.com/Paroxy/Quiver", error);
  }
  for (const repo of ["SirDiabo/GHLAppList"] as const) {
    try {
      const meta = metadata(c, repo);
      const ref = commit(c, meta);
      {
        const id = "githublauncher";
        const file = "apps.json";
        const got = content(c, repo, file, ref);
        c.save(id, got);
        const data = rec(got.data);
        const entries = data.apps ?? Object.values(data).flat();
        if (!Array.isArray(entries)) throw new Error("Malformed registry entries");
        accept({
          id,
          status: "complete",
          evidence: got.evidence,
          next_page: null,
          truncated: false,
          records: entries.map((v) => ({ key: entryKey(rec(v)), fingerprint: observationHash(v) })),
          repository_id: meta.id,
          commit: ref,
          blob: got.blob,
          coverage: "Exact source snapshot; served catalog mapping not revalidated",
        });
      }
    } catch (e) {
      fail("githublauncher", `https://github.com/${repo}`, e);
    }
  }
  try {
    const meta = metadata(c, "RetroPortingToolKit/Retro-Catalog");
    const repo = str(meta.full_name);
    const ref = commit(c, meta);
    const got = content(c, repo, "index.json", ref);
    c.save("retcomm-index", got);
    accept({
      id: "retcomm-index",
      status: "complete",
      evidence: got.evidence,
      next_page: null,
      truncated: false,
      records: [{ key: "index", fingerprint: observationHash(got.data) }],
      repository_id: meta.id,
      continuity: "Historical transfer continuity requires independently bound provider identity",
    });
    const tree = rec(c.api.request("GET", `repos/${repo}/git/trees/${ref}?recursive=1`).body);
    if (tree.truncated !== false || !Array.isArray(tree.tree))
      throw new Error("RetComM tree is incomplete");
    const paths = new Map(tree.tree.map(rec).map((n) => [str(n.path), str(n.sha)]));
    const platforms = rec(rec(got.data).platforms);
    const titles: {
      key: string;
      file: string;
      platform: string;
      sha: string;
      changed: boolean;
      checked: string;
    }[] = [];
    for (const [platform, value] of Object.entries(platforms)) {
      const p = rec(value);
      if (!Array.isArray(p.titles)) throw new Error("Malformed RetComM title list");
      for (const title of p.titles) {
        const key = `retcomm-${str(title)}`;
        const file = `${str(p.dir)}/${str(title)}.json`;
        const sha = paths.get(file);
        if (!sha) throw new Error("Indexed RetComM title absent from exact tree");
        const previous = known.sources[key];
        titles.push({
          key,
          file,
          platform,
          sha,
          changed: previous?.hashes[`blob:${file}`] !== observationHash(sha),
          checked: previous?.completed_at ?? "",
        });
      }
    }
    accept({
      id: "retcomm-tree",
      status: "complete",
      evidence: got.evidence,
      next_page: null,
      truncated: false,
      records: titles.map((t) => ({ key: t.file, fingerprint: observationHash(t.sha) })),
    });
    titles.sort(
      (a, b) =>
        Number(b.changed) - Number(a.changed) ||
        a.checked.localeCompare(b.checked) ||
        a.file.localeCompare(b.file),
    );
    const pending = titles.filter((t) => due(t.changed, t.checked));
    const finished = new Set<string>();
    queues.push({
      jobs: pending.map((t) => ({
        id: t.key,
        evidence: `https://github.com/${repo}/blob/${ref}/${t.file}`,
        run: () => {
          const manifest = content(c, repo, t.file, ref);
          if (manifest.blob !== t.sha)
            throw new Error("RetComM content differs from the exact tree blob");
          c.save(t.key, manifest);
          accept({
            id: t.key,
            status: "complete",
            evidence: manifest.evidence,
            next_page: null,
            truncated: false,
            records: [
              { key: t.file, fingerprint: observationHash(manifest.data) },
              { key: `blob:${t.file}`, fingerprint: observationHash(t.sha) },
            ],
            platform: t.platform,
            blob: manifest.blob,
          });
          finished.add(t.file);
        },
      })),
      finish: () => {
        const remaining = pending.filter((t) => !finished.has(t.file));
        accept({
          id: "retcomm-manifest-coverage",
          status: remaining.length ? "partial" : "complete",
          evidence: got.evidence,
          next_page: null,
          truncated: false,
          records: [],
          uncollected: remaining.length,
          next_path: remaining[0]?.file ?? null,
          next_action:
            "Exact changed/missing and seven-day overdue manifests; completed per-file blob positions persist before continuing",
        });
      },
    });
  } catch (e) {
    fail("retcomm-collection", "https://github.com/RetroPortingToolKit/Retro-Catalog", e);
  }
  try {
    const meta = metadata(c, "zamiba/portforge-mediaitems");
    const ref = commit(c, meta);
    const tree = rec(
      c.api.request("GET", `repos/${str(meta.full_name)}/git/trees/${ref}?recursive=1`).body,
    );
    if (!Array.isArray(tree.tree)) throw new Error("Malformed recipe tree");
    const entries = tree.tree
      .map(rec)
      .filter((n) => typeof n.path === "string" && /\.(?:mediaitem|forge)\.json$/u.test(n.path));
    entries.sort((a, b) => {
      const old = (n: Record<string, unknown>) =>
        known.sources[`portforge-${observationHash(n.path).slice(0, 12)}`];
      const changed = (n: Record<string, unknown>) =>
        old(n)?.hashes[`blob:${str(n.path)}`] !== observationHash(n.sha);
      return (
        Number(changed(b)) - Number(changed(a)) ||
        (old(a)?.completed_at ?? "").localeCompare(old(b)?.completed_at ?? "")
      );
    });
    const pending = entries.filter((entry) => {
      const old = known.sources[`portforge-${observationHash(entry.path).slice(0, 12)}`];
      return due(
        old?.hashes[`blob:${str(entry.path)}`] !== observationHash(entry.sha),
        old?.completed_at ?? "",
      );
    });
    const finished = new Set<string>();
    queues.push({
      jobs: pending.map((entry) => ({
        id: `portforge-${observationHash(entry.path).slice(0, 12)}`,
        evidence: `https://github.com/${str(meta.full_name)}/blob/${ref}/${str(entry.path)}`,
        run: () => {
          const file = str(entry.path);
          const id = `portforge-${observationHash(file).slice(0, 12)}`;
          const got = content(c, str(meta.full_name), file, ref);
          if (got.blob !== entry.sha)
            throw new Error("PortForge content differs from the exact tree blob");
          c.save(id, got);
          accept({
            id,
            status: "complete",
            evidence: got.evidence,
            next_page: null,
            truncated: false,
            records: [
              { key: file, fingerprint: observationHash(got.data) },
              { key: `blob:${file}`, fingerprint: observationHash(entry.sha) },
            ],
          });
          finished.add(file);
        },
      })),
      finish: () => {
        const remaining = pending.filter((entry) => !finished.has(str(entry.path)));
        accept({
          id: "portforge-tree",
          status: tree.truncated === false && !remaining.length ? "complete" : "partial",
          evidence: `https://github.com/${str(meta.full_name)}/tree/${ref}`,
          next_page: null,
          truncated: tree.truncated !== false,
          records: entries.map((n) => ({ key: str(n.path), fingerprint: observationHash(n.sha) })),
          inspected_paths: [...finished],
          uncollected: remaining.length,
          next_path: remaining[0]?.path ?? null,
        });
      },
    });
  } catch (e) {
    fail("portforge", "https://github.com/zamiba/portforge-mediaitems", e);
  }
  try {
    const page = c.http.request(
      "GET",
      "https://www.pcgamingwiki.com/wiki/List_of_unofficial_ports",
    );
    c.save("pcgamingwiki", page);
    accept({
      id: "pcgamingwiki",
      status: page.status === 200 ? "partial" : "inaccessible",
      evidence: "https://www.pcgamingwiki.com/wiki/List_of_unofficial_ports",
      next_page: null,
      truncated: false,
      records: [],
      http_status: page.status,
      next_action:
        page.status === 200
          ? "Review revision and relevant changed rows before declaring complete table coverage"
          : "Resume on restored normal access",
    });
  } catch (e) {
    fail("pcgamingwiki", "https://www.pcgamingwiki.com/wiki/List_of_unofficial_ports", e);
  }
  try {
    accept(collectRecompBoardSource(c, known));
  } catch (e) {
    fail("recomp-board-feed", "https://recomp.fyi/feed.xml", e);
  }
  let exhausted = false;
  try {
    while (queues.some((queue) => queue.jobs.length)) {
      for (const queue of queues) {
        const job = queue.jobs.shift();
        if (!job) continue;
        try {
          c.budget.admit(1, 1);
          job.run();
        } catch (error) {
          if (
            error instanceof GitHubApiError &&
            ["budget_exhausted", "rate_limited"].includes(error.code)
          ) {
            exhausted = true;
            break;
          }
          fail(job.id, job.evidence, error);
        }
      }
      if (exhausted) break;
    }
  } finally {
    for (const queue of queues) queue.finish();
  }
  return result;
}
export function consumeConfiguredObserver(c: SourceContext) {
  const expected = rec(
    JSON.parse(readFileSync(new URL("../release/upstream-observer.json", import.meta.url), "utf8")),
  );
  const runs = rec(
    c.api.request(
      "GET",
      "repos/boburning/portcove/actions/workflows/354075266/runs?event=schedule&per_page=5",
    ).body,
  );
  if (!Array.isArray(runs.workflow_runs)) throw new Error("Missing scheduled observer runs");
  const run = runs.workflow_runs
    .map(rec)
    .find((r) => r.status === "completed" && r.conclusion === "success");
  if (!run) throw new Error("No successful scheduled observer in bounded recent window");
  const artifacts = c.api
    .paginateRest(
      `repos/boburning/portcove/actions/runs/${String(run.id)}/artifacts?per_page=100`,
      {
        identity: (v) => rec(v).id,
        select: (v) => rec(v).artifacts,
        totalCount: (v) => Number(rec(v).total_count),
        label: "observer artifacts",
      },
    )
    .map(rec);
  const artifact = artifacts.find(
    (a) =>
      a.name === `configured-upstream-observation-${String(run.id)}-${String(run.run_attempt)}` &&
      !a.expired,
  );
  if (!artifact || Number(artifact.size_in_bytes) > 2 * 1024 * 1024)
    throw new Error("Missing/oversized observer artifact");
  const response = c.http.request("GET", str(artifact.archive_download_url), undefined, true);
  if (response.status !== 200) throw new Error("Observer artifact unavailable");
  const got = readDiscoveryReport(
    Buffer.from(response.text, "base64"),
    typeof artifact.digest === "string" ? artifact.digest : undefined,
  );
  const report = rec(got.report);
  const execution = rec(report.execution),
    observation = rec(report.observation),
    scope = rec(report.configured_scope);
  if (
    report.format !== 1 ||
    report.config_sha256 !== observationHash(expected) ||
    scope.repository_id !== expected.repository_id ||
    scope.repository !== expected.repository ||
    scope.port_id !== expected.port_id ||
    scope.stale_after_hours !== expected.stale_after_hours ||
    execution.run_id !== String(run.id) ||
    execution.run_attempt !== String(run.run_attempt) ||
    execution.kind !== "schedule" ||
    execution.source_commit !== run.head_sha ||
    report.stale !== false ||
    report.exception !== null ||
    typeof report.last_complete_at !== "string" ||
    !Number.isFinite(Date.parse(report.last_complete_at)) ||
    Date.parse(report.last_complete_at) > Date.now() + 60000 ||
    typeof scope.stale_after_hours !== "number" ||
    !Number.isFinite(scope.stale_after_hours) ||
    scope.stale_after_hours <= 0 ||
    Date.now() - Date.parse(report.last_complete_at) > Number(scope.stale_after_hours) * 3600000 ||
    observationHash(observation.facts) !== observation.facts_sha256
  )
    throw new Error("Observer report binding, freshness or facts mismatch");
  c.save("configured-observer", { ...got, run, artifact });
  return {
    id: `configured-observer-${String(scope.repository_id)}`,
    status: "complete" as const,
    evidence: str(run.html_url),
    next_page: null,
    truncated: false,
    records: [
      { key: `repo:${String(scope.repository_id)}`, fingerprint: str(observation.facts_sha256) },
    ],
  };
}
export function investigateDiscoveryUpstream(c: SourceContext, repository: string) {
  const meta = metadata(c, repository);
  if (!c.primaryProgress) return investigatePrimary(c, meta);
  const repo = str(meta.full_name);
  if (
    repo.toLowerCase() !== repository.toLowerCase() ||
    !Number.isSafeInteger(meta.id) ||
    Number(meta.id) < 1
  )
    throw new Error("Research repository identity changed; independent continuity review required");
  const reads = new DiscoveryPrimaryReads(c.api, repo, Number(meta.id), c.primaryProgress);
  const api = Object.create(c.api) as GitHubApiClient;
  api.request = (_method, endpoint) => ({
    ...reads.request(endpoint),
    rateLimit: { resource: null, limit: null, remaining: null, used: null, resetAt: null },
  });
  try {
    const data = investigatePrimary({ ...c, api }, meta);
    const observed_at = reads.finish();
    return { ...data, observed_at };
  } catch (error) {
    if (!(error instanceof GitHubApiError) && !(error instanceof DiscoveryCheckpointInterrupted))
      reads.discard();
    throw error;
  }
}
function investigatePrimary(c: SourceContext, meta: Record<string, unknown>) {
  const repo = str(meta.full_name);
  const releases = list(
    c,
    `repos/${repo}/releases?per_page=10`,
    "complete upstream release listing",
  ).map(rec);
  const ordered = [...releases]
    .filter((r) => !r.draft)
    .sort(
      (a, b) =>
        Date.parse(String(b.published_at ?? b.created_at)) -
        Date.parse(String(a.published_at ?? a.created_at)),
    );
  const selected = [
    ...new Map(
      [
        ordered.find((r) => !r.prerelease),
        ordered.find((r) => r.prerelease),
        ordered.find((r) => /rolling|nightly|continuous/iu.test(str(r.tag_name))),
      ]
        .filter((r): r is Record<string, unknown> => !!r)
        .map((r) => [r.id, r]),
    ).values(),
  ];
  for (const release of selected) {
    release.assets = list(
      c,
      `repos/${repo}/releases/${String(release.id)}/assets?per_page=100`,
      "selected release assets",
    );
    let target = rec(
      rec(
        c.api.request(
          "GET",
          `repos/${repo}/git/ref/tags/${encodeURIComponent(str(release.tag_name))}`,
        ).body,
      ).object,
    );
    let depth = 0;
    while (target.type === "tag" && depth++ < 4)
      target = rec(
        rec(c.api.request("GET", `repos/${repo}/git/tags/${str(target.sha)}`).body).object,
      );
    if (target.type !== "commit") throw new Error("Selected tag target unresolved");
    release.resolved_tag_commit = str(target.sha);
  }
  const ref = selected[0] ? str(selected[0].resolved_tag_commit) : commit(c, meta);
  const readme = rec(c.api.request("GET", `repos/${repo}/readme?ref=${ref}`).body);
  // One optional project-authored manifest per investigation, inside the same
  // charged budget. Multi-game siblings require separately scoped primary reads.
  let manifest: ReturnType<typeof parseRecompManifest> | undefined;
  let manifest_evidence: { commit: string; blob?: unknown; status: string; error?: string } = {
    commit: ref,
    status: "not-observed",
  };
  try {
    const got = rec(c.api.request("GET", `repos/${repo}/contents/.recomp.json?ref=${ref}`).body);
    manifest = parseRecompManifest(
      JSON.parse(Buffer.from(str(got.content), "base64").toString("utf8")),
    );
    manifest_evidence = { commit: ref, blob: got.sha, status: "project-claim" };
  } catch (e) {
    if (e instanceof DiscoveryCheckpointInterrupted) throw e;
    if (
      e instanceof GitHubApiError &&
      (["budget_exhausted", "rate_limited"].includes(e.code) ||
        e.status === 429 ||
        e.status === 403 ||
        e.status === 401 ||
        (e.status !== null && e.status >= 500))
    )
      throw e;
    manifest_evidence = { commit: ref, status: "unavailable-or-invalid", error: errorMessage(e) };
  }
  return {
    observed_at: undefined as string | undefined,
    metadata: meta,
    releases,
    selected,
    readme: {
      commit: ref,
      blob: readme.sha,
      text: Buffer.from(str(readme.content), "base64").toString("utf8"),
    },
    fingerprint: releaseFingerprint(selected),
    manifest,
    manifest_evidence,
    scope:
      "Current provider release buckets; policy eligibility and historic tag targets remain unassessed",
  };
}

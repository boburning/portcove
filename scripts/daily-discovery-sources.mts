import { GitHubApiClient } from "./github-api.mts";
import { readFileSync } from "node:fs";
import { observationHash } from "./upstream-observer.mts";
import { releaseFingerprint } from "./discovery-checkpoint.mts";
import type { DiscoveryCheckpoint } from "./discovery-checkpoint.mts";
import { readDiscoveryReport } from "./discovery-artifact.mts";
import { isRecord, errorMessage } from "./runtime-values.mts";
import { collectQuiver } from "./daily-discovery-quiver.mts";
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
}
function list(c: SourceContext, endpoint: string, label: string) {
  return c.api.paginateRest(endpoint, { identity: (v) => rec(v).id, label });
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
  const result: CollectedSource[] = [collectQuiver(c)];
  const fail = (id: string, evidence: string, error: unknown) =>
    result.push({
      id,
      status: "inaccessible",
      evidence,
      next_page: null,
      truncated: false,
      records: [],
      error: errorMessage(error),
    });
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
        result.push({
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
    result.push({
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
    result.push({
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
    for (const t of titles.slice(0, 8)) {
      const manifest = content(c, repo, t.file, ref);
      c.save(t.key, manifest);
      result.push({
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
    }
    result.push({
      id: "retcomm-manifest-coverage",
      status: titles.filter((t) => t.changed).length > 8 ? "partial" : "complete",
      evidence: got.evidence,
      next_page: null,
      truncated: false,
      records: [],
      uncollected: Math.max(0, titles.filter((t) => t.changed).length - 8),
      next_path: titles[8]?.file ?? null,
      next_action:
        "Changed manifests first, then oldest checked manifest; pending research remains separate",
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
    for (const entry of entries.slice(0, 8)) {
      const file = str(entry.path);
      const id = `portforge-${observationHash(file).slice(0, 12)}`;
      const got = content(c, str(meta.full_name), file, ref);
      c.save(id, got);
      result.push({
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
    }
    result.push({
      id: "portforge-tree",
      status: tree.truncated === false ? "complete" : "partial",
      evidence: `https://github.com/${str(meta.full_name)}/tree/${ref}`,
      next_page: null,
      truncated: tree.truncated !== false,
      records: entries.map((n) => ({ key: str(n.path), fingerprint: observationHash(n.sha) })),
      inspected_paths: entries.slice(0, 8).map((n) => n.path),
      next_path: entries[8]?.path ?? null,
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
    result.push({
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
  return {
    metadata: meta,
    releases,
    selected,
    readme: {
      commit: ref,
      blob: readme.sha,
      text: Buffer.from(str(readme.content), "base64").toString("utf8"),
    },
    fingerprint: releaseFingerprint(selected),
    scope:
      "Current provider release buckets; policy eligibility and historic tag targets remain unassessed",
  };
}

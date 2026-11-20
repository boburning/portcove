import { isRecord } from "./runtime-values.mts";

const pageSize = 100;
const maxRunPages = 10; // GitHub caps the filtered workflow-run list at 1,000 entries.
const maxArtifactPages = 100;
const gitSha = /^[a-f0-9]{40}$/u;
const sha256 = /^[a-f0-9]{64}$/u;
const workflowPath = /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/u;
const releaseBuildEvents = new Set(["push", "release", "workflow_dispatch"]);

interface BuildTarget {
  repository: string;
  repository_id: number;
  source_commit: string;
  artifacts: readonly { sha256: string }[];
}

interface OutputMatch {
  sha256: string;
  run_id: number;
  run_attempt: 1;
  workflow_id: number;
  workflow_path: string;
  artifact_id: number;
  size: number;
  observed_at: string;
}

interface SearchPosition {
  run_page: number;
  run_id: number | null;
  artifact_page: number;
}

export interface UpstreamBuildObservation {
  format_version: 1;
  repository_id: number;
  source_commit: string;
  matches: OutputMatch[];
  search: SearchPosition | null;
}

const firstPage: SearchPosition = { run_page: 1, run_id: null, artifact_page: 1 };

const positiveId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const timestamp = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));

export function readUpstreamBuildObservation(
  value: unknown,
  target: BuildTarget,
): UpstreamBuildObservation | undefined {
  if (
    !isRecord(value) ||
    value.format_version !== 1 ||
    value.repository_id !== target.repository_id ||
    value.source_commit !== target.source_commit ||
    !Array.isArray(value.matches) ||
    value.matches.length > target.artifacts.length
  )
    return;

  const expected = new Set(target.artifacts.map((entry) => entry.sha256));
  const matches: OutputMatch[] = [];
  const artifactIds = new Set<number>();
  for (const match of value.matches as unknown[]) {
    if (
      !isRecord(match) ||
      typeof match.sha256 !== "string" ||
      !expected.delete(match.sha256) ||
      !positiveId(match.run_id) ||
      match.run_attempt !== 1 ||
      !positiveId(match.workflow_id) ||
      typeof match.workflow_path !== "string" ||
      !workflowPath.test(match.workflow_path) ||
      !positiveId(match.artifact_id) ||
      artifactIds.has(match.artifact_id) ||
      !positiveId(match.size) ||
      !timestamp(match.observed_at)
    )
      return;
    artifactIds.add(match.artifact_id);
    matches.push({
      sha256: match.sha256,
      run_id: match.run_id,
      run_attempt: match.run_attempt,
      workflow_id: match.workflow_id,
      workflow_path: match.workflow_path,
      artifact_id: match.artifact_id,
      size: match.size,
      observed_at: match.observed_at,
    });
  }
  let search: SearchPosition | null = null;
  if (value.search !== null) {
    const cursor = value.search;
    if (
      !isRecord(cursor) ||
      !positiveId(cursor.run_page) ||
      cursor.run_page > maxRunPages ||
      !(cursor.run_id === null || positiveId(cursor.run_id)) ||
      !positiveId(cursor.artifact_page) ||
      cursor.artifact_page > maxArtifactPages ||
      (cursor.run_id === null && cursor.artifact_page !== 1)
    )
      return;
    search = {
      run_page: cursor.run_page,
      run_id: cursor.run_id,
      artifact_page: cursor.artifact_page,
    };
  }
  if ((search === null) !== (expected.size === 0)) return;
  return {
    format_version: 1,
    repository_id: target.repository_id,
    source_commit: target.source_commit,
    matches,
    search,
  };
}

function readPage(value: unknown, key: "workflow_runs" | "artifacts", page: number) {
  if (
    !isRecord(value) ||
    typeof value.total_count !== "number" ||
    !Number.isSafeInteger(value.total_count) ||
    value.total_count < 0
  )
    throw new Error("Upstream GitHub build inventory size is unavailable");
  const rows = value[key];
  const expected = Math.min(pageSize, Math.max(0, value.total_count - (page - 1) * pageSize));
  if (!Array.isArray(rows) || rows.length !== expected)
    throw new Error("Upstream GitHub build inventory page is incomplete");

  const entries: (Record<string, unknown> & { id: number })[] = [];
  const ids = new Set<number>();
  for (const row of rows as unknown[]) {
    if (!isRecord(row) || !positiveId(row.id) || ids.has(row.id))
      throw new Error("Upstream GitHub build inventory page has invalid or repeated IDs");
    ids.add(row.id);
    entries.push({ ...row, id: row.id });
  }
  return { entries, hasMore: value.total_count > page * pageSize };
}

function successfulUpstreamRun(run: Record<string, unknown>, target: BuildTarget) {
  return (
    run.head_sha === target.source_commit &&
    isRecord(run.repository) &&
    run.repository.id === target.repository_id &&
    isRecord(run.head_repository) &&
    run.head_repository.id === target.repository_id &&
    typeof run.event === "string" &&
    releaseBuildEvents.has(run.event) &&
    run.status === "completed" &&
    run.conclusion === "success" &&
    run.run_attempt === 1 &&
    positiveId(run.workflow_id) &&
    typeof run.path === "string" &&
    workflowPath.test(run.path)
  );
}

/** Join exact digest matches to their upstream Actions run. Unmatched packages stay unknown. */
export async function advanceUpstreamArtifactBuildObservation(
  target: BuildTarget,
  prior: UpstreamBuildObservation | undefined,
  read: (endpoint: string) => Promise<unknown>,
  observedAt: string,
): Promise<UpstreamBuildObservation> {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(target.repository) ||
    !positiveId(target.repository_id) ||
    !gitSha.test(target.source_commit) ||
    !target.artifacts.length ||
    target.artifacts.length > 12 ||
    target.artifacts.some(({ sha256: digest }) => !sha256.test(digest)) ||
    !timestamp(observedAt)
  )
    throw new Error("Upstream build observation lacks exact release source or artifact identity");

  const retained = readUpstreamBuildObservation(prior, target);
  const observation: UpstreamBuildObservation = retained ?? {
    format_version: 1,
    repository_id: target.repository_id,
    source_commit: target.source_commit,
    matches: [],
    search: firstPage,
  };
  const cursor = observation.search;
  if (!cursor) return observation;
  const repository = "/repos/" + target.repository;
  const runs = readPage(
    await read(
      repository +
        "/actions/runs?head_sha=" +
        target.source_commit +
        "&status=success&per_page=" +
        pageSize +
        "&page=" +
        cursor.run_page,
    ),
    "workflow_runs",
    cursor.run_page,
  );
  const nextPage =
    runs.hasMore && cursor.run_page < maxRunPages
      ? { run_page: cursor.run_page + 1, run_id: null, artifact_page: 1 }
      : firstPage;

  // Keep the run ID as the anchor inside each page. If it disappeared, revisit
  // the page from its beginning. The scan restarts at page one after a full turn.
  const after = runs.entries.findIndex((run) => run.id === cursor.run_id);
  const start = cursor.artifact_page > 1 && after !== -1 ? after : after + 1;
  const runIndex = runs.entries.findIndex(
    (run, index) => index >= start && successfulUpstreamRun(run, target),
  );
  if (runIndex === -1) return { ...observation, search: nextPage };
  const run = runs.entries[runIndex]!;
  const artifactPage = run.id === cursor.run_id ? cursor.artifact_page : 1;
  const runEndpoint = repository + "/actions/runs/" + run.id;
  const artifacts = readPage(
    await read(runEndpoint + "/artifacts?per_page=" + pageSize + "&page=" + artifactPage),
    "artifacts",
    artifactPage,
  );

  const matches = [...observation.matches];
  const expected = new Set(target.artifacts.map((entry) => entry.sha256));
  const retainedArtifactIds = new Set(matches.map((match) => match.artifact_id));
  for (const match of matches) expected.delete(match.sha256);
  for (const artifact of artifacts.entries) {
    if (
      typeof artifact.digest !== "string" ||
      !artifact.digest.startsWith("sha256:") ||
      retainedArtifactIds.has(artifact.id) ||
      artifact.expired !== false ||
      !positiveId(artifact.size_in_bytes) ||
      !isRecord(artifact.workflow_run) ||
      artifact.workflow_run.id !== run.id ||
      artifact.workflow_run.repository_id !== target.repository_id ||
      artifact.workflow_run.head_repository_id !== target.repository_id ||
      artifact.workflow_run.head_sha !== target.source_commit ||
      !timestamp(artifact.created_at) ||
      !timestamp(run.run_started_at) ||
      Date.parse(artifact.created_at) < Date.parse(run.run_started_at) ||
      !timestamp(run.updated_at) ||
      Date.parse(artifact.created_at) > Date.parse(run.updated_at)
    )
      continue;
    const digest = artifact.digest.slice(7);
    if (!expected.delete(digest)) continue;
    matches.push({
      sha256: digest,
      run_id: run.id,
      run_attempt: 1,
      workflow_id: Number(run.workflow_id),
      workflow_path: String(run.path),
      artifact_id: artifact.id,
      size: artifact.size_in_bytes,
      observed_at: observedAt,
    });
  }

  if (matches.length !== observation.matches.length) {
    // Artifacts are run-scoped. Recheck the first attempt before retaining any
    // matches so a concurrently started retry cannot change the provenance.
    const current = await read(runEndpoint);
    if (
      !isRecord(current) ||
      current.id !== run.id ||
      current.workflow_id !== run.workflow_id ||
      current.path !== run.path ||
      current.run_started_at !== run.run_started_at ||
      current.event !== run.event ||
      !successfulUpstreamRun(current, target)
    )
      throw new Error("Upstream workflow identity changed during build observation");
  }

  let search: SearchPosition | null = null;
  if (expected.size > 0) {
    if (artifacts.hasMore && artifactPage < maxArtifactPages)
      search = { run_page: cursor.run_page, run_id: run.id, artifact_page: artifactPage + 1 };
    else if (runIndex + 1 < runs.entries.length)
      search = { run_page: cursor.run_page, run_id: run.id, artifact_page: 1 };
    else search = nextPage;
  }
  return {
    ...observation,
    matches: matches.sort((a, b) => a.sha256.localeCompare(b.sha256)),
    search,
  };
}

export function isUpstreamBuildMetadataUrl(url: URL) {
  const root = /^\/repos\/[^/]+\/[^/]+\/actions\/runs(.*)$/u.exec(url.pathname);
  if (!root) return false;
  if (root[1] === "") {
    const query = /^\?head_sha=[a-f0-9]{40}&status=success&per_page=100&page=([1-9]\d*)$/u.exec(
      url.search,
    );
    return !!query && Number(query[1]) <= maxRunPages;
  }
  if (/^\/[1-9]\d*$/u.test(root[1] ?? "")) return url.search === "";
  const query = /^\?per_page=100&page=([1-9]\d*)$/u.exec(url.search);
  return (
    /^\/[1-9]\d*\/artifacts$/u.test(root[1] ?? "") &&
    !!query &&
    Number(query[1]) <= maxArtifactPages
  );
}

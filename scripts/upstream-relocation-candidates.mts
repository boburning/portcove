/**
 * Read-only relocation candidates for upstream repositories that GitHub reports
 * as moved (#4784). For each named repository this makes at most two bounded
 * metadata reads: the declared `/repos/{owner}/{name}`, and, only when that
 * returns a 301 naming a numeric repository, `/repositories/{id}`. No redirect
 * is followed, no Location header is retained and nothing is written. Output is
 * an inert proposal for a reviewed catalog or lineage change; it grants no
 * lineage, relocation, acquisition or accounting authority.
 */
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGitHubClient, type GitHubRequestPolicy } from "./github-client.mts";
import { GitHubApiError } from "./github-operation.mts";
import { localDeveloperCredential } from "./github-cli.mts";
import { isRecord } from "./runtime-values.mts";

export type RelocationStatus =
  | "same-repository-renamed"
  | "different-repository"
  | "identity-unbound"
  | "not-moved"
  | "name-reused"
  | "unavailable"
  | "unknown";

export interface RelocationCandidate {
  repository: string;
  status: RelocationStatus;
  http_status: number | null;
  redirect_repository_id: number | null;
  retained_repository_id: number | null;
  current_full_name: string | null;
  current_archived: boolean | null;
  next_step: string;
}

export interface MetadataRead {
  (path: string): Promise<{ status: number; data: unknown }>;
}

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const movedPattern = /^https:\/\/api\.github\.com\/repositories\/([1-9]\d{0,15})$/u;

const nextSteps: Record<RelocationStatus, string> = {
  "same-repository-renamed":
    "Review the rename and, if accepted, update the declared repository through a reviewed catalog change; qualification, holds and accepted bytes do not transfer by themselves.",
  "different-repository":
    "The redirect target is not the retained repository identity. Treat it as an unrelated location until separate continuity evidence is reviewed.",
  "identity-unbound":
    "No retained numeric identity exists for comparison. Establish continuity from reviewed evidence before proposing a catalog change.",
  "not-moved": "The declared repository resolves directly; no relocation is indicated.",
  "name-reused":
    "The declared name now resolves to a different numeric repository. Hold the source and review name reuse before any change.",
  unavailable:
    "The declared repository is unavailable (HTTP 404). A 404 cannot establish deletion, retirement or succession.",
  unknown:
    "Metadata was incomplete or unexpected. Retry a bounded fresh lookup; nothing is inferred.",
};

function candidate(
  repository: string,
  status: RelocationStatus,
  fields: Partial<Omit<RelocationCandidate, "repository" | "status" | "next_step">> = {},
): RelocationCandidate {
  return {
    repository,
    status,
    http_status: fields.http_status ?? null,
    redirect_repository_id: fields.redirect_repository_id ?? null,
    retained_repository_id: fields.retained_repository_id ?? null,
    current_full_name: fields.current_full_name ?? null,
    current_archived: fields.current_archived ?? null,
    next_step: nextSteps[status],
  };
}

/** Classify one declared repository against its retained numeric identity. */
export async function relocationCandidate(
  repository: string,
  retainedRepositoryId: number | null,
  read: MetadataRead,
): Promise<RelocationCandidate> {
  if (!repositoryPattern.test(repository))
    throw new Error(`Invalid repository name: ${repository}`);
  const retained = { retained_repository_id: retainedRepositoryId };
  const declared = await read(`/repos/${repository}`);
  if (declared.status === 404)
    return candidate(repository, "unavailable", { ...retained, http_status: 404 });
  if (declared.status === 200) {
    const id = isRecord(declared.data) ? declared.data.id : undefined;
    if (!Number.isSafeInteger(id))
      return candidate(repository, "unknown", { ...retained, http_status: 200 });
    return candidate(
      repository,
      retainedRepositoryId !== null && id !== retainedRepositoryId ? "name-reused" : "not-moved",
      { ...retained, http_status: 200 },
    );
  }
  const moved =
    declared.status === 301 &&
    isRecord(declared.data) &&
    declared.data.message === "Moved Permanently" &&
    typeof declared.data.url === "string"
      ? movedPattern.exec(declared.data.url)
      : null;
  if (!moved)
    return candidate(repository, "unknown", { ...retained, http_status: declared.status });
  const redirectId = Number(moved[1]);
  const fields = {
    ...retained,
    http_status: 301,
    redirect_repository_id: redirectId,
  };
  if (retainedRepositoryId !== null && redirectId !== retainedRepositoryId)
    return candidate(repository, "different-repository", fields);
  const target = await read(`/repositories/${redirectId}`);
  const data = target.status === 200 && isRecord(target.data) ? target.data : null;
  if (
    !data ||
    data.id !== redirectId ||
    typeof data.full_name !== "string" ||
    !repositoryPattern.test(data.full_name)
  )
    return candidate(repository, "unknown", fields);
  return candidate(
    repository,
    retainedRepositoryId === null ? "identity-unbound" : "same-repository-renamed",
    {
      ...fields,
      current_full_name: data.full_name,
      current_archived: data.archived === true,
    },
  );
}

/** Retained numeric identities from an observer catalog checkpoint. */
export function retainedRepositoryIds(checkpoint: unknown): Map<string, number> {
  const ids = new Map<string, number>();
  if (!isRecord(checkpoint) || !isRecord(checkpoint.sources)) return ids;
  for (const progress of Object.values(checkpoint.sources)) {
    if (
      isRecord(progress) &&
      (progress.provider ?? "github") === "github" &&
      typeof progress.repository === "string" &&
      Number.isSafeInteger(progress.repository_id) &&
      Number(progress.repository_id) > 0
    )
      ids.set(progress.repository.toLowerCase(), Number(progress.repository_id));
  }
  return ids;
}

/**
 * Repositories whose latest observer failure may be a move or removal. A first
 * identity lookup reports HTTP 301/404 directly, but a source with a retained
 * identity fails in its release listing, where a refused redirect surfaces as a
 * generic transport failure. Both are probed; a transient error simply
 * classifies as `not-moved` or `unknown`.
 */
const candidateRules = new Set(["repository-unavailable", "provider-transport", "transport"]);

/** Observer source keys the checkpoint records as GitHub-provider sources. */
export function githubSourceKeys(checkpoint: unknown): Set<string> {
  const keys = new Set<string>();
  if (!isRecord(checkpoint) || !isRecord(checkpoint.sources)) return keys;
  for (const [key, progress] of Object.entries(checkpoint.sources))
    if (isRecord(progress) && (progress.provider ?? "github") === "github") keys.add(key);
  return keys;
}

/**
 * Only failures whose source the checkpoint records as a GitHub provider are
 * selected; GitLab and direct-manifest transport failures share rule names but
 * must never be probed against GitHub.
 */
export function relocationRepositoriesFromReport(
  report: unknown,
  githubSources: ReadonlySet<string>,
): string[] | null {
  if (!isRecord(report) || !Array.isArray(report.failures)) return null;
  const failures = report.failures;
  const repositories = new Set<string>();
  for (const failure of failures) {
    if (
      isRecord(failure) &&
      typeof failure.source === "string" &&
      githubSources.has(failure.source) &&
      typeof failure.repository === "string" &&
      repositoryPattern.test(failure.repository) &&
      typeof failure.rule === "string" &&
      candidateRules.has(failure.rule)
    )
      repositories.add(failure.repository);
  }
  return [...repositories].sort().slice(0, 64);
}

export function renderRelocationSummary(result: Awaited<ReturnType<typeof relocationCandidates>>) {
  const rows = result.candidates.map(
    (c) =>
      `| \`${c.repository}\` | ${c.status} | ${c.current_full_name ? `\`${c.current_full_name}\`` : ""} | ${c.next_step} |`,
  );
  return [
    "### Upstream relocation candidates (proposal only)",
    "",
    "No redirect was followed and nothing was changed. Apply accepted renames through a reviewed catalog change.",
    "",
    "| Declared | Status | Current name | Next step |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

export async function relocationCandidates(
  repositories: readonly string[],
  retained: ReadonlyMap<string, number>,
  read: MetadataRead,
) {
  if (repositories.length === 0 || repositories.length > 64)
    throw new Error("Name between 1 and 64 repositories");
  const candidates: RelocationCandidate[] = [];
  for (const repository of repositories) {
    const retainedId = retained.get(repository.toLowerCase()) ?? null;
    try {
      candidates.push(await relocationCandidate(repository, retainedId, read));
    } catch (error) {
      if (!repositoryPattern.test(repository)) throw error;
      // A bounded read failure leaves this repository unassessed, not the run.
      candidates.push(candidate(repository, "unknown", { retained_repository_id: retainedId }));
    }
  }
  return {
    format: 1,
    authority: "proposal-only",
    redirects_followed: false,
    candidates,
  };
}

async function main(args: string[]) {
  const repositories: string[] = [];
  let checkpointPath: string | null = null;
  let summaryPath: string | null = null;
  let coverageUnknown = false;
  let reportPath: string | null = null;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    const value = args[index + 1];
    if (
      !["--repository", "--checkpoint", "--report", "--summary"].includes(flag ?? "") ||
      value === undefined
    )
      throw new Error(
        "usage: upstream-relocation-candidates.mts (--repository OWNER/NAME | --report PATH) [...] [--checkpoint PATH] [--summary PATH]",
      );
    if (flag === "--repository") repositories.push(value);
    else if (flag === "--report") reportPath = value;
    else if (flag === "--checkpoint") checkpointPath = value;
    else summaryPath = value;
    index++;
  }
  const checkpoint: unknown = checkpointPath
    ? JSON.parse(await readFile(checkpointPath, "utf8"))
    : null;
  const retained = retainedRepositoryIds(checkpoint);
  if (reportPath) {
    const selected = relocationRepositoriesFromReport(
      JSON.parse(await readFile(reportPath, "utf8")),
      githubSourceKeys(checkpoint),
    );
    if (selected === null) coverageUnknown = true;
    else repositories.push(...selected);
  }
  if (repositories.length === 0) {
    console.log(
      JSON.stringify({
        format: 1,
        authority: "proposal-only",
        coverage_unknown: coverageUnknown,
        candidates: [],
      }),
    );
    if (summaryPath && coverageUnknown)
      await appendFile(
        summaryPath,
        "### Upstream relocation candidates (proposal only)\n\nCoverage unknown: the run summary has no failure list, so no candidates were assessed.\n",
      );
    return;
  }
  const deadline = performance.now() + 60_000;
  const sdk = await createGitHubClient({
    credential: localDeveloperCredential({ deadline }),
    deadline,
    maxBytes: 1024 * 1024,
    observeRedirects: true,
    headers: { accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    allowRequest: (method, url) =>
      method === "GET" &&
      (/^\/repos\/[^/]+\/[^/]+$/u.test(url.pathname) ||
        /^\/repositories\/[1-9]\d*$/u.test(url.pathname)),
  });
  const read: MetadataRead = async (endpoint) => {
    const policy: GitHubRequestPolicy = {
      replay: "once",
      attempts: 0,
      readRedirectBodyFor: [301],
    };
    try {
      const response = await sdk.request({
        method: "GET",
        url: endpoint,
        request: { portcove: policy },
      });
      return { status: response.status, data: response.data as unknown };
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404)
        return { status: 404, data: null };
      throw error;
    }
  };
  const result = await relocationCandidates(
    [...new Set(repositories)].slice(0, 64),
    retained,
    read,
  );
  console.log(JSON.stringify(result, null, 2));
  if (summaryPath) await appendFile(summaryPath, renderRelocationSummary(result));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]))
  await main(process.argv.slice(2));

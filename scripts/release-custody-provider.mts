import { createGitHubClient } from "./github-client.mts";
import { GitHubApiError, nextLink } from "./github-operation.mts";
import { coordinatorCommandDeadline } from "./release-coordinator-deadline.mts";

export interface HistoricalJobProvider {
  attempt(run: string, attempt: number): Promise<unknown>;
  jobs(run: string, attempt: number, page: number): Promise<{ body: unknown; next: string | null }>;
  job(id: number): Promise<unknown>;
}

export interface CatalogAnchorMetadataProvider {
  commit(sha: string): Promise<unknown>;
  tree(sha: string, recursive?: boolean): Promise<unknown>;
  blob(sha: string): Promise<unknown>;
}

export interface BootstrapSiteMetadataProvider {
  repository(deadline: number): Promise<unknown>;
  pages(deadline: number): Promise<unknown>;
}

export interface HostedNativeSourceProvider {
  commit(sha: string): Promise<unknown>;
  file(filename: string, revision: string): Promise<unknown>;
}

export interface ImmutableReleaseMetadataProvider {
  releases(page: number): Promise<unknown>;
  versionTag(tag: string): Promise<{ kind: "absent" } | { kind: "present"; data: unknown }>;
  annotatedTag(sha: string): Promise<unknown>;
  releaseAssets(id: number, page: number): Promise<unknown>;
  release(id: number): Promise<unknown>;
}

type ReleaseCustodyProvider = HistoricalJobProvider &
  HostedNativeSourceProvider &
  CatalogAnchorMetadataProvider &
  BootstrapSiteMetadataProvider &
  ImmutableReleaseMetadataProvider & {
    run(id: string): Promise<unknown>;
    artifact(id: number): Promise<unknown>;
    runArtifacts(id: string, page: number): Promise<unknown>;
  };
export type RunArtifactInventoryProvider = Pick<ReleaseCustodyProvider, "runArtifacts">;
export type SigningOutputMetadataProvider = Pick<
  ReleaseCustodyProvider,
  "attempt" | "job" | "artifact"
>;
export type ReleaseArtifactMetadataProvider = Pick<
  ReleaseCustodyProvider,
  "commit" | "run" | "attempt" | "job" | "artifact"
>;

/** Source and original-job reads share one credential and original deadline.
 * The retained proof owner accounts for its reads across observations. A later
 * request deadline can tighten that original lifetime. */
export async function createReleaseCustodyProvider(options: {
  token: string;
  deadline: number;
  requestTimeoutMs?: 15000 | 30000;
  maxBytes?: number;
  currentDeadline?: () => number;
  chargeRead?: () => void;
  afterRead?: () => void;
  fetch?: typeof globalThis.fetch;
}): Promise<ReleaseCustodyProvider> {
  const {
    token,
    deadline: phaseDeadline,
    requestTimeoutMs = 15000,
    maxBytes = 2 * 1024 ** 2,
    currentDeadline,
    chargeRead,
    afterRead,
    fetch,
  } = options;
  const deadline = Math.min(phaseDeadline, coordinatorCommandDeadline() ?? Infinity);
  const client = await createGitHubClient({
    credential: { kind: "explicit", token },
    deadline,
    maxBytes,
    requestTimeoutMs,
    headers: { accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    ...(fetch ? { fetch } : {}),
  });
  const get = async (
    route: string,
    parameters: Record<string, unknown>,
    requestDeadline = deadline,
  ) => {
    chargeRead?.();
    const response = await client
      .request(`GET ${route}`, {
        ...parameters,
        owner: "boburning",
        repo: "portcove",
        request: {
          portcove: {
            replay: "once",
            attempts: 0,
            deadline: Math.min(
              requestDeadline,
              currentDeadline?.() ?? deadline,
              coordinatorCommandDeadline() ?? Infinity,
            ),
          },
        },
      })
      .finally(() => afterRead?.());
    if (response.status !== 200) throw new Error("release custody provider read unavailable");
    return response;
  };
  return {
    async repository(limit) {
      return (await get("/repos/{owner}/{repo}", {}, limit)).data as unknown;
    },
    async pages(limit) {
      return (await get("/repos/{owner}/{repo}/pages", {}, limit)).data as unknown;
    },
    async releases(page) {
      return (await get("/repos/{owner}/{repo}/releases", { per_page: 100, page })).data as unknown;
    },
    async versionTag(tag) {
      try {
        const result = await get("/repos/{owner}/{repo}/git/ref/tags/{tag}", { tag });
        return { kind: "present", data: result.data as unknown };
      } catch (error) {
        if (error instanceof GitHubApiError && error.status === 404) return { kind: "absent" };
        throw error;
      }
    },
    async annotatedTag(sha) {
      return (await get("/repos/{owner}/{repo}/git/tags/{tag_sha}", { tag_sha: sha }))
        .data as unknown;
    },
    async releaseAssets(id, page) {
      return (
        await get("/repos/{owner}/{repo}/releases/{release_id}/assets", {
          release_id: id,
          per_page: 100,
          page,
        })
      ).data as unknown;
    },
    async release(id) {
      return (await get("/repos/{owner}/{repo}/releases/{release_id}", { release_id: id }))
        .data as unknown;
    },
    async run(id) {
      return (await get("/repos/{owner}/{repo}/actions/runs/{run_id}", { run_id: id }))
        .data as unknown;
    },
    async runArtifacts(id, page) {
      return (
        await get("/repos/{owner}/{repo}/actions/runs/{run_id}/artifacts", {
          run_id: id,
          page,
          per_page: 100,
        })
      ).data as unknown;
    },
    async artifact(id) {
      return (
        await get("/repos/{owner}/{repo}/actions/artifacts/{artifact_id}", { artifact_id: id })
      ).data as unknown;
    },
    async attempt(run, attempt) {
      return (
        await get("/repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}", {
          run_id: run,
          attempt_number: attempt,
        })
      ).data as unknown;
    },
    async jobs(run, attempt, page) {
      const result = await get(
        "/repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs",
        {
          run_id: run,
          attempt_number: attempt,
          page,
          per_page: 100,
        },
      );
      const link = result.headers.link;
      return {
        body: result.data as unknown,
        next: typeof link === "string" ? nextLink(new Map([["link", link]])) : null,
      };
    },
    async job(id) {
      return (await get("/repos/{owner}/{repo}/actions/jobs/{job_id}", { job_id: id }))
        .data as unknown;
    },
    async commit(sha) {
      return (await get("/repos/{owner}/{repo}/git/commits/{commit_sha}", { commit_sha: sha }))
        .data as unknown;
    },
    async tree(sha, recursive = true) {
      return (
        await get("/repos/{owner}/{repo}/git/trees/{tree_sha}", {
          tree_sha: sha,
          ...(recursive ? { recursive: 1 } : {}),
        })
      ).data as unknown;
    },
    async blob(sha) {
      return (await get("/repos/{owner}/{repo}/git/blobs/{file_sha}", { file_sha: sha }))
        .data as unknown;
    },
    async file(filename, revision) {
      return (await get("/repos/{owner}/{repo}/contents/{path}", { path: filename, ref: revision }))
        .data as unknown;
    },
  };
}

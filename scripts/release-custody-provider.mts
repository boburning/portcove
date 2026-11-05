import { createGitHubClient } from "./github-client.mts";
import { nextLink } from "./github-operation.mts";

export interface HistoricalJobProvider {
  attempt(run: string, attempt: number): Promise<unknown>;
  jobs(run: string, attempt: number, page: number): Promise<{ body: unknown; next: string | null }>;
  job(id: number): Promise<unknown>;
}

export interface HostedNativeSourceProvider {
  commit(sha: string): Promise<unknown>;
  file(filename: string, revision: string): Promise<unknown>;
}

/** Source and original-job reads share one credential and original deadline.
 * The retained proof owner accounts for its reads across observations. */
export async function createReleaseCustodyProvider(options: {
  token: string;
  deadline: number;
  jobTimeoutMs?: 15000 | 30000;
  fetch?: typeof globalThis.fetch;
}): Promise<HistoricalJobProvider & HostedNativeSourceProvider> {
  const { token, deadline, jobTimeoutMs = 15000 } = options;
  const client = await createGitHubClient({
    credential: { kind: "explicit", token },
    deadline,
    maxBytes: 2 * 1024 * 1024,
    requestTimeoutMs: 30000,
    headers: { accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const get = async (
    route: string,
    parameters: Record<string, unknown>,
    milliseconds = jobTimeoutMs,
  ) => {
    const response = await client.request(`GET ${route}`, {
      ...parameters,
      owner: "boburning",
      repo: "portcove",
      request: {
        portcove: {
          replay: "once",
          attempts: 0,
          deadline: Math.min(deadline, performance.now() + milliseconds),
        },
      },
    });
    if (response.status !== 200) throw new Error("release custody provider read unavailable");
    return response;
  };
  return {
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
      return (
        await get("/repos/{owner}/{repo}/git/commits/{commit_sha}", { commit_sha: sha }, 30000)
      ).data as unknown;
    },
    async file(filename, revision) {
      return (
        await get("/repos/{owner}/{repo}/contents/{path}", { path: filename, ref: revision }, 30000)
      ).data as unknown;
    },
  };
}

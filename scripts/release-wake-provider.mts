import { createGitHubClient } from "./github-client.mts";
import type { GitHubCredential, GitHubRequestPolicy } from "./github-client.mts";

export type WakeResponse = { status: number; body: unknown };
export type RetainWakeResponse = (response: WakeResponse) => Promise<void>;
export interface WakeDispatch {
  ref: string;
  inputs: Record<string, unknown>;
  return_run_details: boolean;
}
export type WakeWorkflow =
  | "application-update-wake.yml"
  | "application-update-production.yml"
  | "job-token-dispatch-fixture.yml"
  | "application-release.yml";
export interface WakeProvider {
  repository(): Promise<unknown>;
  run(id: string, retain?: RetainWakeResponse): Promise<unknown>;
  jobs(id: string, attempt?: number): Promise<unknown>;
  ref(name: string): Promise<unknown>;
  file(filename: string, revision: string): Promise<unknown>;
  runs(workflow: WakeWorkflow, filters: Record<string, string>, page: number): Promise<unknown>;
  artifacts(run: string): Promise<unknown>;
  artifact(id: number): Promise<unknown>;
  dispatch(
    workflow: WakeWorkflow,
    body: WakeDispatch,
    retain?: RetainWakeResponse,
  ): Promise<WakeResponse>;
}

/** Fixed repository operations. Credentials and the original job deadline are
 * supplied by the owning workflow; this adapter grants no dispatch authority. */
export async function createWakeProvider(options: {
  credential: GitHubCredential;
  deadline: number;
  remainingDeadline: () => number;
  apiVersion: string;
  maxBytes: number;
  maxRequests?: number;
  requestTimeoutMs?: 10000 | 30000;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}): Promise<WakeProvider> {
  const client = await createGitHubClient({
    credential: options.credential,
    deadline: options.deadline,
    maxBytes: options.maxBytes,
    requestTimeoutMs: options.requestTimeoutMs ?? 10000,
    headers: { accept: "application/vnd.github+json", "X-GitHub-Api-Version": options.apiVersion },
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  let requests = 0;
  const policy = (retain?: RetainWakeResponse): GitHubRequestPolicy => {
    if (++requests > (options.maxRequests ?? Infinity))
      throw new Error("wake provider request budget exhausted");
    return {
      replay: "once",
      attempts: 0,
      deadline: options.remainingDeadline(),
      ...(retain
        ? { retainResponse: async ({ status, data }) => retain({ status, body: data }) }
        : {}),
    };
  };
  const repository = { owner: "boburning", repo: "portcove" };
  const get = async (
    route: string,
    parameters: Record<string, unknown>,
    retain?: RetainWakeResponse,
  ) => {
    const response = await client.request(`GET ${route}`, {
      ...parameters,
      ...repository,
      request: { portcove: policy(retain) },
    });
    if (response.status !== 200) throw new Error("wake provider readback unavailable");
    return response.data as unknown;
  };
  return {
    repository: () => get("/repos/{owner}/{repo}", {}),
    run: (id, retain) => get("/repos/{owner}/{repo}/actions/runs/{run_id}", { run_id: id }, retain),
    jobs: (id, attempt = 1) =>
      get("/repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs", {
        run_id: id,
        attempt_number: attempt,
        per_page: 100,
      }),
    ref: (name) => get("/repos/{owner}/{repo}/git/ref/{ref}", { ref: name }),
    file: (filename, revision) =>
      get("/repos/{owner}/{repo}/contents/{path}", { path: filename, ref: revision }),
    runs: (workflow, filters, page) =>
      get("/repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs", {
        ...filters,
        workflow_id: workflow,
        page,
        per_page: 100,
      }),
    artifacts: (id) =>
      get("/repos/{owner}/{repo}/actions/runs/{run_id}/artifacts", { run_id: id, per_page: 100 }),
    artifact: (id) =>
      get("/repos/{owner}/{repo}/actions/artifacts/{artifact_id}", { artifact_id: id }),
    async dispatch(workflow, body, retain) {
      const parameters = structuredClone(body);
      const response = await client.request(
        "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches",
        {
          ...parameters,
          ...repository,
          workflow_id: workflow,
          request: { portcove: policy(retain) },
        },
      );
      return { status: response.status, body: response.data };
    },
  };
}

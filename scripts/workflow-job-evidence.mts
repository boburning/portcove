import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Octokit } from "@octokit/core";
import { isRecord } from "./runtime-values.mts";

const repository = "boburning/portcove";
const origin = "https://api.github.com";
const metadataBytes = 2 * 1024 ** 2;

async function boundedBody(response: Response, maximum: number) {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maximum)) {
    await response.body?.cancel();
    throw new Error("Workflow evidence exceeds its byte limit");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const data: unknown = chunk.value;
      if (!(data instanceof Uint8Array)) throw new Error("Invalid workflow evidence body");
      bytes += data.byteLength;
      if (bytes > maximum) {
        await reader.cancel();
        throw new Error("Workflow evidence exceeds its byte limit");
      }
      chunks.push(data);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytes);
}

/** Fixed read-only workflow evidence. The caller supplies github-script's pinned
 * client. The repository verifier continues to own interpretation of the data. */
export async function collectWorkflowJobEvidence(
  github: Pick<Octokit, "request">,
  mode: "browser" | "timeout",
  environment = process.env,
) {
  const { GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_SHA, RUNNER_TEMP } =
    environment;
  if (
    GITHUB_REPOSITORY !== repository ||
    !GITHUB_RUN_ID ||
    !/^[1-9][0-9]{0,15}$/u.test(GITHUB_RUN_ID) ||
    !GITHUB_RUN_ATTEMPT ||
    !/^[1-9][0-9]{0,8}$/u.test(GITHUB_RUN_ATTEMPT) ||
    !GITHUB_SHA ||
    !/^[a-f0-9]{40}$/u.test(GITHUB_SHA) ||
    !RUNNER_TEMP ||
    !path.isAbsolute(RUNNER_TEMP)
  )
    throw new Error("Fixed workflow evidence identity unavailable");

  const operation = AbortSignal.timeout(60_000);
  const requestSignal = () => AbortSignal.any([operation, AbortSignal.timeout(15_000)]);
  const get = async (suffix: string, expectedStatus = 200) => {
    const url = `${origin}/repos/${repository}${suffix}`;
    const signal = requestSignal();
    try {
      const response = await github.request(`GET ${url}`, {
        request: {
          signal,
          log: { debug() {}, info() {}, warn() {}, error() {} },
          fetch: async (input: string, init: RequestInit) => {
            if (input !== url || init.method !== "GET")
              throw new Error("Unexpected evidence route");
            const response = await fetch(input, { ...init, signal, redirect: "manual" });
            if (response.status !== expectedStatus) {
              await response.body?.cancel();
              throw new Error("Unexpected evidence response status");
            }
            const body = await boundedBody(response, metadataBytes);
            return new Response(new Uint8Array(body), {
              status: response.status,
              headers: response.headers,
            });
          },
        },
      });
      signal.throwIfAborted();
      if (response.status !== expectedStatus) throw new Error("Evidence status mismatch");
      return { data: response.data as unknown, headers: response.headers };
    } catch {
      throw new Error("Fixed GitHub workflow evidence request failed");
    }
  };
  const save = (name: string, data: string | Uint8Array) =>
    writeFile(path.join(RUNNER_TEMP, name), data, { flag: "wx", mode: 0o600 });
  const jobs = await get(
    `/actions/runs/${GITHUB_RUN_ID}/attempts/${GITHUB_RUN_ATTEMPT}/jobs?per_page=100`,
  );
  if (
    jobs.headers.link !== undefined ||
    !isRecord(jobs.data) ||
    !Array.isArray(jobs.data.jobs) ||
    jobs.data.total_count !== jobs.data.jobs.length ||
    jobs.data.jobs.length > 100
  )
    throw new Error("Incomplete fixed workflow job inventory");
  if (mode === "browser") {
    await save("browser-custody-jobs.json", JSON.stringify(jobs.data));
    return;
  }
  if (mode !== "timeout" || jobs.data.jobs.length !== 2)
    throw new Error("Invalid timeout job inventory");
  const matches = jobs.data.jobs.filter(
    (row: unknown) => isRecord(row) && row.name === "controlled-job-timeout",
  );
  const job: unknown = matches[0];
  if (
    matches.length !== 1 ||
    !isRecord(job) ||
    typeof job.id !== "number" ||
    !Number.isSafeInteger(job.id) ||
    job.id < 1 ||
    String(job.run_id) !== GITHUB_RUN_ID ||
    String(job.run_attempt) !== GITHUB_RUN_ATTEMPT ||
    job.head_sha !== GITHUB_SHA ||
    typeof job.check_run_url !== "string"
  )
    throw new Error("Original timeout job identity unavailable");
  const checkPrefix = `${origin}/repos/${repository}/check-runs/`;
  const checkId = job.check_run_url.slice(checkPrefix.length);
  if (!job.check_run_url.startsWith(checkPrefix) || !/^[1-9][0-9]{0,15}$/u.test(checkId))
    throw new Error("Original timeout Check identity unavailable");
  const redirect = await get(`/actions/jobs/${job.id}/logs`, 302);
  let bytes: Buffer;
  try {
    const url = new URL(redirect.headers.location ?? "");
    if (
      url.protocol !== "https:" ||
      url.port ||
      url.username ||
      url.password ||
      url.hash ||
      !/^productionresultssa[0-9]+\.blob\.core\.windows\.net$/u.test(url.hostname) ||
      !url.pathname.startsWith("/actions-results/") ||
      !url.searchParams.has("sig")
    )
      throw new Error("Unexpected signed log route");
    const signal = requestSignal();
    const response = await fetch(url, { redirect: "error", signal });
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error("Signed log unavailable");
    }
    bytes = await boundedBody(response, 8 * 1024 ** 2);
    signal.throwIfAborted();
  } catch {
    throw new Error("Fixed signed timeout log download failed");
  }
  const check = await get(`/check-runs/${checkId}`);
  const annotations = await get(`/check-runs/${checkId}/annotations?per_page=100`);
  if (annotations.headers.link !== undefined || !Array.isArray(annotations.data))
    throw new Error("Incomplete fixed Check annotation inventory");
  await save("timeout-jobs.json", JSON.stringify(jobs.data));
  await save("timeout-job.log", bytes);
  await save("timeout-check.json", JSON.stringify(check.data));
  await save("timeout-annotations.json", JSON.stringify(annotations.data));
}

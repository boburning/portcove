import { execFileSync } from "node:child_process";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { downloadRetainedRebootArtifactFile } from "../../github-artifact-download.mts";
import { createGitHubClient } from "../../github-client.mts";
import { GitHubApiError } from "../../github-operation.mts";
import { assertTrustedDirectNode } from "../../release-direct-node-transport.mts";
import { assertOwnedUnlinkedPath } from "../../release-path-safety.mts";
import { errorCode, isRecord } from "../../runtime-values.mts";
import frozen from "./cohort.json" with { type: "json" };

const repository = "boburning/portcove";
const artifactName = "retained-cohort.zip";
const transferScope =
  "Exact retained artifact only; delivery credentials and partial bytes remain private";
type Cohort = Pick<
  typeof frozen,
  "run" | "source" | "attempt" | "workflow_id" | "artifact" | "archive_bytes" | "archive_sha256"
>;
type Context = { controller_source: string; controller_run: string; controller_attempt: string };

function requireFields(raw: unknown, expected: Record<string, unknown>, message: string) {
  if (!isRecord(raw) || !Object.entries(expected).every(([key, value]) => raw[key] === value))
    throw new Error(message);
  return raw;
}

async function requireNewFile(filename: string) {
  try {
    await lstat(filename);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  throw new Error("Never replace an earlier retained reboot attempt");
}

export async function acquireRetainedRebootArchive(
  root: string,
  cohort: Cohort,
  context: Context,
  token: string,
  fetch: typeof globalThis.fetch = globalThis.fetch,
) {
  if (!token || token.length > 16384 || /\s/u.test(token))
    throw new Error("Explicit retained reboot artifact reader required");
  const archive = path.join(root, artifactName);
  await requireNewFile(path.join(root, "tuple.json"));
  await requireNewFile(archive);
  const status = await open(path.join(root, "artifact-download.status.json"), "wx", 0o600);
  const runRoute = `/repos/${repository}/actions/runs/${cohort.run}`,
    artifactRoute = `/repos/${repository}/actions/artifacts/${cohort.artifact}`;
  const run = {
    id: cohort.run,
    head_sha: cohort.source,
    run_attempt: cohort.attempt,
    workflow_id: cohort.workflow_id,
    status: "completed",
    conclusion: "success",
  };
  const artifact = {
    id: cohort.artifact,
    expired: false,
    size_in_bytes: cohort.archive_bytes,
    digest: `sha256:${cohort.archive_sha256}`,
  };
  const workflowRun = { id: cohort.run, head_sha: cohort.source };
  const expected = { run, artifact: { ...artifact, workflow_run: workflowRun } };
  const credential = { kind: "explicit" as const, token };
  const deadline = performance.now() + 15 * 60_000;
  let before, after, downloaded;
  let failure: { error: unknown } | undefined;
  try {
    const api = await createGitHubClient({
      credential,
      deadline,
      maxBytes: 1024 * 1024,
      requestTimeoutMs: 30000,
      fetch,
      allowRequest: (method, url) =>
        method === "GET" && !url.search && [runRoute, artifactRoute].includes(url.pathname),
    });
    const get = async (route: string) => {
      const response = await api.request(`GET ${route}`, {
        request: { portcove: { replay: "once", attempts: 0 } },
      });
      if (response.status !== 200) throw new Error("Frozen cohort metadata is unavailable");
      return response.data as unknown;
    };
    const observe = async () => {
      requireFields(await get(runRoute), run, "Frozen producer identity changed");
      const actual = requireFields(
        await get(artifactRoute),
        artifact,
        "Frozen artifact identity changed",
      );
      requireFields(actual.workflow_run, workflowRun, "Frozen artifact producer changed");
      return expected;
    };
    before = await observe();
    downloaded = await downloadRetainedRebootArtifactFile(
      artifactRoute.slice(1) + "/zip",
      archive,
      {
        credential,
        deadline: Math.min(deadline, performance.now() + 600000),
        maxBytes: cohort.archive_bytes,
        fetch,
      },
    );
    if (downloaded.sha256 !== cohort.archive_sha256)
      throw new Error("Frozen artifact bytes disagree");
    after = await observe();
  } catch (error) {
    failure = { error };
    throw error;
  } finally {
    const error = failure?.error;
    const code = error instanceof GitHubApiError ? error.code : failure ? "identity_or_io" : null;
    try {
      await status.writeFile(
        `${JSON.stringify(
          {
            ...context,
            code: failure ? null : 0,
            timed_out: code === "deadline_exceeded",
            error_type: code,
            provider_status: error instanceof GitHubApiError ? error.status : null,
            before,
            after,
            archive: downloaded,
            scope: transferScope,
          },
          null,
          2,
        )}\n`,
      );
      await status.sync();
    } finally {
      await status.close();
    }
  }
}

async function runHostedAcquisition() {
  const env = process.env;
  if (!process.geteuid || process.geteuid() === 0)
    throw new Error("Ordinary hosted caller required");
  requireFields(
    env,
    {
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: repository,
      GITHUB_EVENT_NAME: "workflow_dispatch",
      RUNNER_ENVIRONMENT: "github-hosted",
      RUNNER_OS: "Linux",
      RUNNER_ARCH: "X64",
      GITHUB_JOB: "linux-retained-reboot",
    },
    "Unexpected retained reboot hosted context",
  );
  const {
    GITHUB_SHA: source,
    GITHUB_RUN_ID: run,
    GITHUB_RUN_ATTEMPT: attempt,
    GITHUB_WORKSPACE: workspace,
    GITHUB_WORKFLOW_REF: workflow,
  } = env;
  if (
    !source ||
    !/^[0-9a-f]{40}$/u.test(source) ||
    !run ||
    !/^[1-9][0-9]{0,15}$/u.test(run) ||
    !attempt ||
    !/^[1-9][0-9]{0,15}$/u.test(attempt) ||
    !workflow?.startsWith(
      `${repository}/.github/workflows/updater-artifact-rehearsal.yml@refs/heads/`,
    )
  )
    throw new Error("Exact retained reboot workflow source, run and attempt required");
  const checkout = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
  if (!workspace || workspace !== checkout || (await realpath(workspace)) !== workspace)
    throw new Error("Direct retained reboot checkout required");
  const head = execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], {
    cwd: workspace,
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
    encoding: "utf8",
    timeout: 20000,
    maxBuffer: 1024,
  }).trim();
  if (head !== source) throw new Error("Checkout does not match dispatched head");
  const root = await assertOwnedUnlinkedPath(
    workspace,
    path.join(workspace, "work/updater-linux-reboot"),
    "Retained reboot root",
  );
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory() || info.uid !== process.geteuid() || (info.mode & 0o077) !== 0)
    throw new Error("Private owned retained reboot root required");
  assertTrustedDirectNode("Retained reboot archive");
  await acquireRetainedRebootArchive(
    root,
    frozen,
    {
      controller_source: source,
      controller_run: run,
      controller_attempt: attempt,
    },
    env.GH_TOKEN ?? "",
  );
}

if (import.meta.main) {
  try {
    await runHostedAcquisition();
  } catch {
    console.error(
      "Retained reboot artifact acquisition refused; inspect the bounded status evidence.",
    );
    process.exitCode = 1;
  }
}

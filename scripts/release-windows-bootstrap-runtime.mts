/** Source-appointed Windows prerequisite before any protected role credential. The
 * existing source factory and actual signed numeric job identity stay in this
 * realm; a serialized receipt or raw environment cannot appoint the caller. */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { parseDocument } from "yaml";
import { createGitHubClient } from "./github-client.mts";
import { isRecord } from "./runtime-values.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import {
  admitProductionWindowsToolBootstrap,
  admitProductionNativeParent,
  requireAdmittedProductionSource,
  readProductionControllerWorkflowBytes,
} from "./production-controller-admission.mts";
import {
  controllerToolBootstrapProfile,
  hostedNativeJobProfile,
  verifyHostedNativeJobIdentity,
  controllerOidcSubject,
  requestAssemblerToken,
  verifyControllerToolBootstrapJobIdentity,
} from "./assembler-job-identity.mts";
import {
  inspectWindowsSourceSystemCustody,
  recheckWindowsSourceSystemCustody,
  windowsSourceSystemExecutables,
} from "./release-native-runtime-custody.mts";
import { inspectSupportedHostedWindowsRuntimeInput } from "./hosted-windows-runtime-input.mts";
export const protectedWindowsRuntimePreparationExecutionAuthorized = true;
export const protectedWindowsNativeRuntimePreparationExecutionAuthorized = true;
// Sequential download60s + installer300s + disposal/receipt/settlement90s.
export const protectedWindowsRuntimeHelperMilliseconds = 450000;
export const protectedWindowsRuntimeFinalizerReserveMilliseconds = 30000;
const project = fileURLToPath(new URL("..", import.meta.url)),
  hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export function readSupportedRuntimeMechanism(bytes: Buffer) {
  assert.ok(bytes.length > 0 && bytes.length <= 131072);
  const text = bytes.toString("utf8");
  assert.ok(Buffer.from(text).equals(bytes));
  const part = (name: string) => {
    const begin = `# portcove-supported-runtime-${name}-begin`,
      end = `# portcove-supported-runtime-${name}-end`;
    assert.equal(text.split(begin).length, 2);
    assert.equal(text.split(end).length, 2);
    const a = text.indexOf(begin) + begin.length,
      b = text.indexOf(end);
    assert.ok(b > a);
    return text.slice(a, b);
  };
  return { prelude: part("prelude"), effects: part("effects"), source_sha256: hash(bytes) };
}
/** Timing arithmetic only. Caller must first authenticate the original numeric
 * provider job, admitted source workflow and in-progress metadata. This cannot
 * appoint a producer or renew the original provider window. */
export function remainingProtectedWindowsRuntimeWindow(input: {
  startedAt: number;
  providerDate: number;
  localDate: number;
  minutes: number;
  requestMilliseconds: number;
}) {
  assert.ok(Object.values(input).every(Number.isFinite));
  assert.ok(Number.isSafeInteger(input.minutes) && input.minutes > 0 && input.minutes <= 360);
  assert.ok(input.requestMilliseconds >= 0 && input.requestMilliseconds <= 15000);
  assert.ok(input.startedAt <= input.providerDate);
  assert.ok(Math.abs(input.localDate - input.providerDate) <= 30000);
  const remaining =
    input.startedAt + input.minutes * 60000 - input.providerDate - input.requestMilliseconds;
  assert.ok(
    remaining >=
      protectedWindowsRuntimeHelperMilliseconds +
        protectedWindowsRuntimeFinalizerReserveMilliseconds,
    "Original provider job cannot preserve complete sequential runtime preparation and settlement; resource amendment required",
  );
  return remaining;
}
/** Read the numeric job for the already authenticated source-appointed issuer.
 * The provider Date and body must come from the same original one-shot read. */
export async function readProtectedWindowsRuntimeDeadline(input: {
  jobId: number;
  revision: string;
  runId: string;
  jobName: string;
  minutes: number;
  readerToken: string;
}) {
  const { jobId, revision, runId, jobName, minutes, readerToken } = input;
  assert.ok(Number.isSafeInteger(jobId) && jobId > 0);
  const started = performance.now();
  const route = `/repos/boburning/portcove/actions/jobs/${jobId}`;
  const sdk = await createGitHubClient({
    credential: { kind: "explicit", token: readerToken },
    deadline: started + 15000,
    maxBytes: 128 * 1024,
    headers: { accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    allowRequest: (method, url) => method === "GET" && url.pathname === route && !url.search,
  });
  const response = await sdk.request(`GET ${route}`, {
    request: { portcove: { replay: "once", attempts: 0 } },
  });
  const job: unknown = response.data;
  assert.equal(response.status, 200);
  assert.ok(
    isRecord(job) &&
      job.id === jobId &&
      job.head_sha === revision &&
      String(job.run_id) === runId &&
      job.run_attempt === 1 &&
      job.name === jobName &&
      job.status === "in_progress" &&
      typeof job.started_at === "string",
    "Original protected Windows runtime job identity differs",
  );
  const providerDate = Date.parse(response.headers.date ?? "");
  const remaining = remainingProtectedWindowsRuntimeWindow({
    startedAt: Date.parse(job.started_at),
    providerDate,
    localDate: Date.now(),
    minutes,
    requestMilliseconds: performance.now() - started,
  });
  return {
    deadline: performance.now() + remaining,
    startedAt: job.started_at,
    providerObservedAt: new Date(providerDate).toISOString(),
  };
}
export async function prepareAdmittedWindowsBootstrapRuntime() {
  return prepareAdmittedWindowsSourceRuntime("bootstrap");
}
export async function prepareAdmittedWindowsNativeRuntime() {
  return prepareAdmittedWindowsSourceRuntime("native");
}
async function prepareAdmittedWindowsSourceRuntime(role: "bootstrap" | "native") {
  assert.ok(
    role === "bootstrap"
      ? protectedWindowsRuntimePreparationExecutionAuthorized
      : protectedWindowsNativeRuntimePreparationExecutionAuthorized,
    "Protected Windows runtime preparation remains held until exact source/configuration/resource authority",
  );
  assert.ok(process.platform === "win32" && process.arch === "x64");
  const environment = { ...process.env };
  assert.equal(environment.PORTCOVE_EXECUTION_PURPOSE, "application");
  for (const key of Object.keys(environment))
    if (
      /^PORTCOVE_CATALOG_(?:DEFINITIONS|POLICY|SNAPSHOT|TIMESTAMP)_KEY$/u.test(key) ||
      /^(?:TAURI_|AWS_|AZURE_|PORTCOVE_(?:CONTROL_APP_TOKEN|SIGNING_|ROOT_KEY|RELEASE_TOKEN))/u.test(
        key,
      )
    )
      throw Error("Role credentials cannot enter runtime source preparation");
  const workflow = await readProductionControllerWorkflowBytes(),
    jobKey = role === "bootstrap" ? "tool_bootstrap_windows" : "native_windows",
    source =
      role === "bootstrap"
        ? admitProductionWindowsToolBootstrap(
            environment.PORTCOVE_CONTROLLER_ADMISSION,
            environment,
            workflow,
          )
        : admitProductionNativeParent(
            environment.PORTCOVE_CONTROLLER_ADMISSION,
            environment,
            workflow,
            "windows-x86_64",
            "payload-signing",
          ),
    system = inspectWindowsSourceSystemCustody();
  const gitEnvironment = {
    PATH: environment.PATH,
    SystemRoot: environment.SystemRoot,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "NUL",
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  const git = (args: string[]) =>
    execFileSync(windowsSourceSystemExecutables.git, args, {
      cwd: project,
      env: gitEnvironment,
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 65536,
      windowsHide: true,
    }).trim();
  const tree = git(["rev-parse", "HEAD^{tree}"]);
  assert.match(tree, /^[a-f0-9]{40}$/u);
  const helperPath = path.join(project, "scripts/prepare-hosted-windows-runtime.ps1"),
    floorPath = path.join(project, "apps/desktop/src-tauri/src/runtime_support.rs"),
    helper = await readControllerToolFile(helperPath, 131072),
    floor = await readControllerToolFile(floorPath, 65536),
    mechanism = readSupportedRuntimeMechanism(helper);
  const recheck = async () => {
    requireAdmittedProductionSource(source, jobKey, "application");
    assert.ok(
      Object.keys(process.env).length === Object.keys(environment).length &&
        Object.keys(environment).every((key) => process.env[key] === environment[key]),
      "Original bootstrap environment changed",
    );
    assert.equal(git(["rev-parse", "HEAD"]), source.revision);
    assert.equal(git(["rev-parse", "HEAD^{tree}"]), tree);
    git(["-c", "core.fsmonitor=false", "diff", "--quiet", "HEAD", "--"]);
    assert.ok(helper.equals(await readControllerToolFile(helperPath, 131072)));
    assert.ok(floor.equals(await readControllerToolFile(floorPath, 65536)));
    recheckWindowsSourceSystemCustody(system);
  };
  await recheck();
  const bootstrapProfile = controllerToolBootstrapProfile("windows-x86_64"),
    nativeProfile = hostedNativeJobProfile("windows-x86_64"),
    profile = role === "bootstrap" ? bootstrapProfile : nativeProfile,
    identityDeadline = performance.now() + 120000,
    token = await requestAssemblerToken(profile.audience, environment, fetch, identityDeadline),
    expected = {
      audience: profile.audience,
      subject:
        role === "bootstrap"
          ? controllerOidcSubject(source.execution_ref)
          : controllerOidcSubject(source.execution_ref, nativeProfile.environment),
      controller_revision: source.revision,
      controller_ref: source.execution_ref,
      actor_id: source.actor_id,
      run_id: source.run_id,
      run_attempt: 1,
    },
    identity =
      role === "bootstrap"
        ? await verifyControllerToolBootstrapJobIdentity(
            token,
            expected,
            { transport: { cwd: project, deadline: identityDeadline } },
            "windows-x86_64",
          )
        : await verifyHostedNativeJobIdentity("windows-x86_64", token, expected, {
            transport: { cwd: project, deadline: identityDeadline },
          });
  assert.equal(identity.evidence_scope, "github.com");
  assert.ok(Date.now() < Date.parse(identity.expires_at));
  await recheck();
  const parsed = parseDocument(workflow.toString("utf8"), { uniqueKeys: true });
  assert.equal(parsed.errors.length, 0);
  const document: unknown = parsed.toJS({ maxAliasCount: 100 });
  assert.ok(isRecord(document) && isRecord(document.jobs) && isRecord(document.jobs[jobKey]));
  const minutes = document.jobs[jobKey]["timeout-minutes"];
  assert.ok(Number.isSafeInteger(minutes) && Number(minutes) > 0 && Number(minutes) <= 360);
  assert.ok(typeof source.run_id === "string");
  const clock = await readProtectedWindowsRuntimeDeadline({
    jobId: identity.job_id,
    revision: source.revision,
    runId: source.run_id,
    jobName: profile.job,
    minutes: Number(minutes),
    readerToken: environment.GH_TOKEN ?? "",
  });
  const originalDeadline = clock.deadline;
  const context = Buffer.from(JSON.stringify({ root: project, source: source.revision })).toString(
      "base64",
    ),
    script = `$ErrorActionPreference='Stop';Set-StrictMode -Version Latest;$v=[Text.UTF8Encoding]::new($false,$true).GetString([Convert]::FromBase64String('${context}'))|ConvertFrom-Json;$taskRepo=$v.root;$taskRuntimeSource=$v.source;$UseStandaloneInstaller=$false;\n${mechanism.prelude}\n${mechanism.effects}`;
  const child: NodeJS.ProcessEnv = {
    SystemRoot: environment.SystemRoot,
    WINDIR: environment.SystemRoot,
    PATH: path.join(environment.SystemRoot ?? "", "System32"),
    PATHEXT: ".EXE",
    TEMP: environment.RUNNER_TEMP,
    TMP: environment.RUNNER_TEMP,
  };
  for (const key of [
    "GITHUB_ACTIONS",
    "RUNNER_ENVIRONMENT",
    "GITHUB_REPOSITORY",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
    "GITHUB_WORKFLOW_REF",
    "GITHUB_SHA",
  ])
    child[key] = environment[key];
  await recheck();
  assert.ok(
    Date.now() < Date.parse(identity.expires_at),
    "Original Windows runtime issuer expired",
  );
  assert.ok(
    originalDeadline - performance.now() >=
      protectedWindowsRuntimeHelperMilliseconds +
        protectedWindowsRuntimeFinalizerReserveMilliseconds,
    "Original provider job cannot preserve complete sequential runtime preparation and settlement; resource amendment required",
  );
  try {
    execFileSync(
      windowsSourceSystemExecutables.powershell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        cwd: project,
        env: child,
        timeout: Math.max(
          1,
          Math.min(
            protectedWindowsRuntimeHelperMilliseconds,
            Math.floor(
              originalDeadline -
                performance.now() -
                protectedWindowsRuntimeFinalizerReserveMilliseconds,
            ),
          ),
        ),
        maxBuffer: 65536,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (error) {
    await writeFile(
      path.join(project, "work/hosted-continuity-evidence/windows-runtime-incomplete.json"),
      JSON.stringify({
        source: source.revision,
        run_id: source.run_id,
        attempt: 1,
        job_id: identity.job_id,
        scope: "Source runtime preparation failed or timed out; preserve original receipt",
        installer_tree_settlement:
          "Unknown; outer process termination is not native installer cleanup proof",
        automatic_retry: false,
        authority: "none",
      }),
      { flag: "wx", mode: 0o600 },
    ).catch(() => {});
    throw error;
  }
  await recheck();
  assert.ok(
    Date.now() < Date.parse(identity.expires_at),
    "Original runtime producer identity expired",
  );
  const receipt = await readControllerToolFile(
      path.join(project, "work/hosted-continuity-evidence/windows-runtime.json"),
      65536,
    ),
    facts = inspectSupportedHostedWindowsRuntimeInput(floor, receipt, {
      source: source.revision,
      workflow: environment.GITHUB_WORKFLOW_REF,
      run_id: source.run_id,
      attempt: "1",
    });
  const provenance = {
    schema_version: 1,
    source: source.revision,
    role,
    job_key: jobKey,
    tree,
    workflow_sha256: source.workflow_sha256,
    producer: identity,
    helper_sha256: mechanism.source_sha256,
    runtime_receipt: { bytes: receipt.length, sha256: hash(receipt) },
    floor_source: { bytes: floor.length, sha256: hash(floor) },
    runtime_version: facts.observed,
    minimum: facts.minimum,
    original_provider_job: {
      started_at: clock.startedAt,
      maximum_minutes: Number(minutes),
      provider_observed_at: clock.providerObservedAt,
      helper_maximum_milliseconds: protectedWindowsRuntimeHelperMilliseconds,
      finalizer_reserve_milliseconds: protectedWindowsRuntimeFinalizerReserveMilliseconds,
    },
    scope:
      "Authenticated source-bootstrap prerequisite only; no candidate, native, signing or publication acceptance",
    authority: "none",
  };
  const bytes = Buffer.from(JSON.stringify(provenance));
  assert.ok(bytes.length <= 65536);
  await writeFile(
    path.join(project, "work/hosted-continuity-evidence/windows-runtime-bootstrap-source.json"),
    bytes,
    { flag: "wx", mode: 0o600 },
  );
  return provenance;
}

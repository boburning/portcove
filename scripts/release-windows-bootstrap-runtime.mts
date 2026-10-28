/** Source-held Windows prerequisite before any protected role credential. The
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
import { GitHubApiClient, createGitHubRunner } from "./github-api.mts";
import { isRecord } from "./runtime-values.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import {
  admitProductionWindowsToolBootstrap,
  requireAdmittedProductionSource,
  readProductionControllerWorkflowBytes,
} from "./production-controller-admission.mts";
import {
  controllerToolBootstrapProfile,
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
export const protectedWindowsRuntimePreparationExecutionAuthorized = false;
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
export async function prepareAdmittedWindowsBootstrapRuntime() {
  assert.ok(
    protectedWindowsRuntimePreparationExecutionAuthorized,
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
    source = admitProductionWindowsToolBootstrap(
      environment.PORTCOVE_CONTROLLER_ADMISSION,
      environment,
      workflow,
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
    requireAdmittedProductionSource(source, "tool_bootstrap_windows", "application");
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
  const profile = controllerToolBootstrapProfile("windows-x86_64"),
    identityDeadline = performance.now() + 120000,
    token = await requestAssemblerToken(profile.audience, environment, fetch, identityDeadline),
    identity = await verifyControllerToolBootstrapJobIdentity(
      token,
      {
        audience: profile.audience,
        subject: controllerOidcSubject(source.execution_ref),
        controller_revision: source.revision,
        controller_ref: source.execution_ref,
        actor_id: source.actor_id,
        run_id: source.run_id,
        run_attempt: 1,
      },
      { transport: { cwd: project, deadline: identityDeadline } },
      "windows-x86_64",
    );
  assert.equal(identity.evidence_scope, "github.com");
  assert.ok(Date.now() < Date.parse(identity.expires_at));
  await recheck();
  const parsed = parseDocument(workflow.toString("utf8"), { uniqueKeys: true });
  assert.equal(parsed.errors.length, 0);
  const document: unknown = parsed.toJS({ maxAliasCount: 100 });
  assert.ok(
    isRecord(document) && isRecord(document.jobs) && isRecord(document.jobs.tool_bootstrap_windows),
  );
  const minutes = document.jobs.tool_bootstrap_windows["timeout-minutes"];
  assert.ok(Number.isSafeInteger(minutes) && Number(minutes) > 0 && Number(minutes) <= 360);
  const readStarted = performance.now();
  const runner = createGitHubRunner({ cwd: project, maxBuffer: 128 * 1024, timeoutMs: 15000 }),
    api = new GitHubApiClient((args, input) =>
      runner([...args, "--hostname", "github.com"], input),
    ),
    job = api.request("GET", `repos/boburning/portcove/actions/jobs/${identity.job_id}`);
  assert.equal(job.status, 200);
  assert.ok(
    isRecord(job.body) &&
      job.body.id === identity.job_id &&
      job.body.head_sha === source.revision &&
      String(job.body.run_id) === source.run_id &&
      job.body.run_attempt === 1 &&
      job.body.name === profile.job &&
      job.body.status === "in_progress" &&
      typeof job.body.started_at === "string",
  );
  const providerDate = Date.parse(job.headers.get("date") ?? ""),
    startedAt = Date.parse(job.body.started_at);
  const remaining = remainingProtectedWindowsRuntimeWindow({
    startedAt,
    providerDate,
    localDate: Date.now(),
    minutes: Number(minutes),
    requestMilliseconds: performance.now() - readStarted,
  });
  const originalDeadline = performance.now() + remaining;
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
    tree,
    workflow_sha256: source.workflow_sha256,
    producer: identity,
    helper_sha256: mechanism.source_sha256,
    runtime_receipt: { bytes: receipt.length, sha256: hash(receipt) },
    floor_source: { bytes: floor.length, sha256: hash(floor) },
    runtime_version: facts.observed,
    minimum: facts.minimum,
    original_provider_job: {
      started_at: job.body.started_at,
      maximum_minutes: Number(minutes),
      provider_observed_at: new Date(providerDate).toISOString(),
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

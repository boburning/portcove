/** Fixed source bootstrap into the attested native runner. Public locators and
 * clock records do not grant admission, proof custody or execution authority. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { assertControllerBootstrapEnvironment } from "./release-controller-job-bootstrap.mts";
import {
  admitProductionNativeParent,
  requireAdmittedProductionSource,
  readProductionControllerWorkflowBytes,
} from "./production-controller-admission.mts";
import { inspectBoundSelectedPublicationAuthorities } from "./release-authority-configuration-contract.mts";
import { currentNativeJobDeadline } from "./release-signing-job-budget.mts";
import {
  receiveControllerTools,
  verifiedControllerToolPaths,
} from "./release-controller-tool-admission.mts";
import { controllerToolPaths, readControllerToolFile } from "./release-controller-tools.mts";
import {
  inspectNativeRuntimeCustody,
  recheckNativeRuntimeCustody,
} from "./release-native-runtime-custody.mts";
import { isRecord } from "./runtime-values.mts";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const maximumNs = 570_000_000_000n;
function hex(value: unknown, length = 64): string {
  assert.ok(typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`, "u").test(value));
  return value;
}
function positive(value: unknown): number {
  assert.ok(typeof value === "string" && /^[1-9][0-9]{0,15}$/u.test(value));
  const result = Number(value);
  assert.ok(Number.isSafeInteger(result));
  return result;
}
function data(raw: string | undefined, maximum: number): unknown {
  assert.ok(raw && Buffer.byteLength(raw) <= maximum);
  return JSON.parse(raw) as unknown;
}
function exact(raw: unknown, keys: string): raw is Record<string, unknown> {
  return isRecord(raw) && Object.keys(raw).sort().join(",") === keys;
}

/** Both operations run on the original native_linux job. Post-sign must reuse
 * the first operation's monotonic clock, never mint a new stage/job allowance. */
export async function launchFixedHostedLinuxNativeJob(operation: unknown) {
  assert.ok(operation === "pre-sign" || operation === "post-sign");
  const environment = { ...process.env };
  assertControllerBootstrapEnvironment(environment);
  assert.equal(process.platform, "linux");
  assert.equal(process.arch, "x64");
  assert.ok(environment.RUNNER_TEMP && path.isAbsolute(environment.RUNNER_TEMP));
  const temporary = environment.RUNNER_TEMP;
  const stage = operation === "pre-sign" ? "payload-signing" : "release-publication";
  const workflow = await readProductionControllerWorkflowBytes();
  const source = admitProductionNativeParent(
    environment.PORTCOVE_CONTROLLER_ADMISSION,
    environment,
    workflow,
    "linux-x86_64",
    stage,
  );
  requireAdmittedProductionSource(source, "native_linux", "application");
  const selected = inspectBoundSelectedPublicationAuthorities(
    data(environment.PORTCOVE_RELEASE_AUTHORITIES, 32768),
    source,
    "application",
  );
  assert.equal(selected.configuration.purpose, "application");
  const identity = {
    controller_revision: source.revision,
    controller_ref: source.execution_ref,
    run_id: String(source.run_id),
    run_attempt: source.run_attempt,
  };
  const binding = digest(
    Buffer.from(
      JSON.stringify({
        identity,
        actor_id: source.actor_id,
        configuration: selected.configuration,
        workflow_sha256: digest(workflow),
      }),
    ),
  );
  const unchanged = () => {
    for (const [key, value] of Object.entries(environment))
      assert.equal(process.env[key], value, "native bootstrap environment changed");
    assertControllerBootstrapEnvironment();
    requireAdmittedProductionSource(source, "native_linux", "application");
  };
  const providerDeadline = currentNativeJobDeadline(
    "linux-x86_64",
    identity,
    fileURLToPath(new URL("..", import.meta.url)),
    performance.now() + 570000,
  );
  unchanged();
  const clockFile = path.join(temporary, "portcove-native-job-clock.json");
  if (operation === "pre-sign") {
    const started = process.hrtime.bigint();
    const remaining = Math.floor(providerDeadline - performance.now());
    assert.ok(remaining > 0 && remaining <= 570000);
    await writeFile(
      clockFile,
      JSON.stringify({
        schema_version: 1,
        binding,
        started_ns: String(started),
        deadline_ns: String(started + BigInt(remaining) * 1_000_000n),
        authority: "none",
      }),
      { flag: "wx", mode: 0o600 },
    );
  }
  const clockCustody = inspectNativeRuntimeCustody([clockFile]);
  const clockBytes = await readControllerToolFile(clockFile, 4096);
  recheckNativeRuntimeCustody([clockFile], clockCustody);
  const clock: unknown = JSON.parse(clockBytes.toString("utf8"));
  assert.ok(exact(clock, "authority,binding,deadline_ns,schema_version,started_ns"));
  assert.equal(clock.schema_version, 1);
  assert.equal(clock.binding, binding);
  assert.equal(clock.authority, "none");
  for (const key of ["started_ns", "deadline_ns"] as const)
    assert.ok(typeof clock[key] === "string" && /^[1-9][0-9]{0,19}$/u.test(clock[key]));
  const started = BigInt(String(clock.started_ns)),
    end = BigInt(String(clock.deadline_ns));
  assert.ok(end > started && end - started <= maximumNs && started <= process.hrtime.bigint());
  const remaining = Number(end - process.hrtime.bigint()) / 1e6;
  assert.ok(remaining > 0 && remaining <= 570000);
  const deadline = Math.min(providerDeadline, performance.now() + remaining);
  const active = () => {
    unchanged();
    recheckNativeRuntimeCustody([clockFile], clockCustody);
    assert.ok(
      performance.now() < deadline && process.hrtime.bigint() < end,
      "original native job clock exhausted",
    );
  };
  active();
  if (operation === "post-sign") {
    const settled: unknown = JSON.parse(
      (
        await readControllerToolFile(
          path.join(temporary, "portcove-native-linux-pre-sign", "native-job-settlement.json"),
          4096,
        )
      ).toString("utf8"),
    );
    assert.ok(
      exact(settled, "authority,exit_code,native_acceptance,provider_bytes_match,schema_version"),
    );
    assert.equal(settled.schema_version, 1);
    assert.equal(settled.exit_code, 0);
    assert.equal(settled.provider_bytes_match, true);
    assert.equal(settled.native_acceptance, "not-established");
    assert.equal(settled.authority, "none");
    // This is a local sequencing hint only. The original post-sign producer
    // independently authenticates coordinator/source/predecessor evidence.
  }
  const needs = data(environment.PORTCOVE_FIXED_NEEDS, 256 * 1024);
  assert.ok(isRecord(needs));
  const bootstrap = needs.tool_bootstrap,
    attest = needs.tool_attest;
  assert.ok(isRecord(bootstrap) && bootstrap.result === "success" && isRecord(bootstrap.outputs));
  assert.ok(isRecord(attest) && attest.result === "success" && isRecord(attest.outputs));
  const artifact = {
    ...identity,
    source_tree: hex(bootstrap.outputs.source_tree, 40),
    artifact_id: positive(bootstrap.outputs.artifact_id),
    sha256: hex(bootstrap.outputs.artifact_sha256),
  };
  const bundle = {
    artifact_id: positive(attest.outputs.bundle_artifact_id),
    sha256: hex(attest.outputs.bundle_artifact_sha256),
  };
  active();
  const root = path.join(temporary, `portcove-native-linux-${operation}`);
  await mkdir(root, { mode: 0o700 });
  active();
  const receipt = await receiveControllerTools(root, artifact, bundle, { deadline });
  active();
  const tools = await verifiedControllerToolPaths(receipt);
  active();
  const custodyFiles = [
    ...controllerToolPaths.map((name) => path.join(tools.root, name)),
    path.join(tools.root, "manifest.json"),
    process.execPath,
  ];
  const custody = inspectNativeRuntimeCustody(custodyFiles);
  assert.equal(
    digest(await readControllerToolFile(process.execPath)),
    digest(await readControllerToolFile(tools.node)),
    "actual native bootstrap Node differs from attested runtime",
  );
  const entry = tools.entries["release-hosted-native-runner"];
  assert.ok(typeof entry === "string");
  await verifiedControllerToolPaths(receipt);
  assert.ok((await readProductionControllerWorkflowBytes()).equals(workflow));
  active();
  recheckNativeRuntimeCustody(custodyFiles, custody);
  const worker = (await import(pathToFileURL(entry).href)) as {
    runConfiguredHostedLinuxNativeJob(
      this: void,
      raw: unknown,
      root: string,
      deadline: number,
      entry: string,
    ): Promise<unknown>;
    runConfiguredHostedLinuxPostSignJob(
      this: void,
      raw: unknown,
      root: string,
      deadline: number,
      entry: string,
    ): Promise<unknown>;
  };
  await verifiedControllerToolPaths(receipt);
  assert.ok((await readProductionControllerWorkflowBytes()).equals(workflow));
  active();
  recheckNativeRuntimeCustody(custodyFiles, custody);
  const run =
    operation === "pre-sign"
      ? worker.runConfiguredHostedLinuxNativeJob
      : worker.runConfiguredHostedLinuxPostSignJob;
  assert.equal(typeof run, "function");
  await writeFile(
    path.join(root, "native-bootstrap-routing.json"),
    JSON.stringify({
      schema_version: 1,
      operation,
      root,
      node: tools.node,
      entry,
      deadline_ns: String(end),
      authority: "none",
    }),
    { flag: "wx", mode: 0o600 },
  );
  active();
  recheckNativeRuntimeCustody(custodyFiles, custody);
  const result: unknown = await run({ tools: { artifact, bundle } }, root, deadline, entry);
  await verifiedControllerToolPaths(receipt);
  assert.ok((await readProductionControllerWorkflowBytes()).equals(workflow));
  active();
  recheckNativeRuntimeCustody(custodyFiles, custody);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const run =
    process.argv.length === 3
      ? launchFixedHostedLinuxNativeJob(process.argv[2])
      : Promise.reject(new Error("fixed native operation required"));
  run
    .then((result) => console.log(JSON.stringify(result)))
    .catch(() => {
      console.error(
        "fixed native bootstrap refused; retain original clock, stage state and effects; no automatic retry",
      );
      process.exitCode = 2;
    });
}

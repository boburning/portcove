/** Actual public-record custody into the keyless shipping verifier component.
 * No native acceptance, publication authority or reusable raw receipt import. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isRecord } from "./runtime-values.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { readNativeCapturedStream } from "./release-native-capture-files.mts";
import { releasePathContains, assertOwnedUnlinkedPath } from "./release-path-safety.mts";
import { readBoundedPublicBuildInputFile } from "./release-public-build-inputs.mts";
import {
  requireActualPublicJourneyPair,
  requireActualPublicJourneyPackage,
} from "./release-native-public-pair.mts";

const run = promisify(execFile);
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const fixedName = () =>
  `verify_packaged_application_update${process.platform === "win32" ? ".exe" : ""}`;
const scope = "shipping payload verifier component only; caller owns public provenance";
function active(deadline: number) {
  assert.ok(
    Number.isFinite(deadline) && performance.now() < deadline,
    "original public signature-control deadline exhausted",
  );
}

/** Fixed command data only; never appoints a tool, public pair or native result. */
export function planPublicSignatureControl(
  tool: string,
  configuration: string,
  configSha256: string,
  directory: string,
  deadline: number,
) {
  active(deadline);
  assert.equal(path.basename(tool), fixedName());
  assert.ok(path.isAbsolute(directory) && path.isAbsolute(tool) && path.isAbsolute(configuration));
  assert.equal(path.dirname(tool), directory);
  assert.equal(configuration, path.join(directory, "control.json"));
  assert.match(configSha256, /^[a-f0-9]{64}$/u);
  return {
    executable: tool,
    arguments: ["public-signature-control", configuration, configSha256],
    options: {
      cwd: directory,
      timeout: Math.max(1, Math.floor(Math.min(120000, deadline - performance.now()))),
      maxBuffer: 64 * 1024,
      windowsHide: true,
      env: {
        PATH: process.platform === "win32" ? `${process.env.SystemRoot}/System32` : "/usr/bin:/bin",
        SystemRoot: process.env.SystemRoot,
        SystemDrive: process.env.SystemDrive,
        WINDIR: process.env.WINDIR,
        HOME: directory,
        USERPROFILE: directory,
        APPDATA: directory,
        LOCALAPPDATA: directory,
        TMP: directory,
        TEMP: directory,
        TMPDIR: directory,
      },
    },
  };
}

type Expected = {
  config_sha256: string;
  registry_sha256: string;
  payload_sha256: string;
  payload_bytes: number;
  payload_key_id: string;
  v1_signature_sha256: string;
  prior_signature_sha256: string;
};
/** Closed output association only, not an authenticated verifier receipt. */
export function inspectPublicSignatureControlReport(raw: unknown, expected: Expected) {
  assert.ok(isRecord(raw));
  assert.equal(
    Object.keys(raw).sort().join(","),
    "authority,config_sha256,kind,native_acceptance,negative,payload_bytes,payload_key_id,payload_sha256,positive,prior_signature_sha256,registry_sha256,schema_version,scope,v1_signature_sha256",
  );
  assert.equal(raw.schema_version, 1);
  assert.equal(raw.kind, "public-signature-control");
  assert.equal(raw.authority, "none");
  assert.equal(raw.native_acceptance, "not-established");
  assert.equal(raw.scope, scope);
  assert.equal(raw.positive, "verified");
  assert.equal(raw.negative, "SignatureMismatch");
  for (const [key, value] of Object.entries(expected)) assert.equal(raw[key], value);
  return structuredClone(raw);
}

type Inputs = Awaited<ReturnType<typeof requireActualPublicJourneyPair>>;
async function actualInputs(
  pairReceipt: object,
  priorReceipt: object,
  candidateReceipt: object,
  deadline: number,
) {
  active(deadline);
  const pair = await requireActualPublicJourneyPair(pairReceipt);
  active(deadline);
  const prior = await requireActualPublicJourneyPackage(priorReceipt);
  active(deadline);
  const candidate = await requireActualPublicJourneyPackage(candidateReceipt);
  active(deadline);
  for (const item of [prior, candidate]) {
    assert.ok(
      "pair_receipt" in item && item.pair_receipt === pairReceipt,
      "package belongs to another actual public pair",
    );
    assert.equal(digest(item.pair.pair), digest(pair.pair));
  }
  assert.equal(prior.slot, "prior");
  assert.equal(candidate.slot, "candidate");
  assert.equal(
    prior.identity.package.payload_key_id,
    candidate.identity.package.payload_key_id,
    "public signature control requires the same authenticated key",
  );
  return { pair, prior, candidate };
}
function selectedTool(pair: Inputs) {
  const transport: unknown = pair.parent.transport_configuration;
  assert.ok(
    isRecord(transport) && isRecord(transport.public_signature_control),
    "protected shipping component tool absent",
  );
  const tool = transport.public_signature_control;
  assert.equal(Object.keys(tool).sort().join(","), "path,sha256");
  assert.ok(typeof tool.path === "string" && path.isAbsolute(tool.path));
  assert.equal(path.basename(tool.path), fixedName());
  assert.ok(
    releasePathContains(pair.parent.controller_root, tool.path),
    "component tool escaped protected controller source",
  );
  assert.ok(typeof tool.sha256 === "string" && /^[a-f0-9]{64}$/u.test(tool.sha256));
  return { path: tool.path, sha256: tool.sha256 };
}
async function read(file: string, maximum: number) {
  return readBoundedPublicBuildInputFile(path.dirname(file), path.basename(file), maximum);
}
const receipts = new WeakMap<
  object,
  {
    pair: object;
    prior: object;
    candidate: object;
    deadline: number;
    directory: string;
    tool: { path: string; sha256: string };
    config: Buffer;
    registry: Buffer;
    stdout: Buffer;
    stderr: Buffer;
    expected: Expected;
    pair_digest: string;
  }
>();

export async function runActualPublicSignatureControl(
  pairReceipt: object,
  priorReceipt: object,
  candidateReceipt: object,
  outputParent: string,
  originalDeadline: number,
) {
  const inputs = await actualInputs(pairReceipt, priorReceipt, candidateReceipt, originalDeadline);
  const deadline = Math.min(originalDeadline, inputs.pair.deadline);
  active(deadline);
  assert.ok(
    path.isAbsolute(outputParent) && releasePathContains(inputs.pair.directory, outputParent),
    "signature output must remain in actual parent custody",
  );
  await assertOwnedUnlinkedPath(
    inputs.pair.directory,
    path.join(outputParent, "public-signature-output"),
    "signature component output",
  );
  active(deadline);
  const tool = selectedTool(inputs.pair);
  const toolBytes = await read(tool.path, 256 * 1024 * 1024);
  active(deadline);
  assert.equal(sha(toolBytes), tool.sha256);
  const registry = await read(
    path.join(inputs.pair.preparation.prepared_root, "payload.json"),
    64 * 1024,
  );
  active(deadline);
  const artifact = inputs.candidate.identity.package;
  const directory = await mkdtemp(path.join(outputParent, "public-signature-"));
  const config = Buffer.from(
    JSON.stringify({
      schema_version: 1,
      payload_path: inputs.candidate.path,
      artifact: {
        url: artifact.url,
        bytes: artifact.bytes,
        sha256: artifact.sha256,
        tauri_signature: artifact.tauri_signature,
        payload_key_id: artifact.payload_key_id,
      },
      prior_signature: inputs.prior.identity.package.tauri_signature,
      prior_payload_key_id: inputs.prior.identity.package.payload_key_id,
      registry_path: path.join(directory, "payload.json"),
      registry_sha256: sha(registry),
    }),
  );
  assert.ok(config.length > 0 && config.length <= 64 * 1024);
  const expected = {
    config_sha256: sha(config),
    registry_sha256: sha(registry),
    payload_sha256: artifact.sha256,
    payload_bytes: artifact.bytes,
    payload_key_id: artifact.payload_key_id,
    v1_signature_sha256: sha(artifact.tauri_signature),
    prior_signature_sha256: sha(inputs.prior.identity.package.tauri_signature),
  };
  const copiedTool = path.join(directory, fixedName());
  for (const [file, bytes, mode] of [
    [copiedTool, toolBytes, 0o500],
    [path.join(directory, "payload.json"), registry, 0o600],
    [path.join(directory, "control.json"), config, 0o600],
  ] as const) {
    active(deadline);
    await writeFile(file, bytes, { flag: "wx", mode });
  }
  assert.equal(sha(await read(copiedTool, 256 * 1024 * 1024)), tool.sha256);
  const plan = planPublicSignatureControl(
    copiedTool,
    path.join(directory, "control.json"),
    expected.config_sha256,
    directory,
    deadline,
  );
  let stdout: Buffer, stderr: Buffer;
  try {
    const result = await run(plan.executable, plan.arguments, {
      ...plan.options,
      encoding: "buffer",
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    if (isRecord(error))
      for (const name of ["stdout", "stderr"] as const) {
        const value = error[name];
        if (typeof value === "string" || Buffer.isBuffer(value))
          await writeFile(
            path.join(directory, `failed.${name}`),
            Buffer.from(value).subarray(0, 64 * 1024),
            { flag: "wx", mode: 0o600 },
          );
      }
    throw error;
  }
  for (const [name, bytes] of [
    ["verifier.stdout.json", stdout],
    ["verifier.stderr.bin", stderr],
  ] as const)
    await writeFile(path.join(directory, name), bytes, { flag: "wx", mode: 0o600 });
  active(deadline);
  assert.ok(stdout.length > 0 && stdout.length <= 64 * 1024 && stderr.length === 0);
  inspectPublicSignatureControlReport(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stdout)),
    expected,
  );
  const receipt = Object.freeze({
    kind: "actual-public-signature-component",
    authority: "none",
    scope: "shipping component only; native subtype not established",
  });
  receipts.set(receipt, {
    pair: pairReceipt,
    prior: priorReceipt,
    candidate: candidateReceipt,
    deadline,
    directory,
    tool,
    config,
    registry,
    stdout,
    stderr,
    expected,
    pair_digest: digest(inputs.pair.pair),
  });
  await requireActualPublicSignatureControl(receipt);
  return receipt;
}

export async function requireActualPublicSignatureControl(receipt: object) {
  const retained = receipts.get(receipt);
  assert.ok(retained, "actual public signature component receipt required");
  active(retained.deadline);
  const inputs = await actualInputs(
    retained.pair,
    retained.prior,
    retained.candidate,
    retained.deadline,
  );
  assert.equal(digest(inputs.pair.pair), retained.pair_digest);
  assert.deepEqual(selectedTool(inputs.pair), retained.tool);
  for (const [file, expected, maximum] of [
    [retained.tool.path, undefined, 256 * 1024 * 1024],
    [path.join(retained.directory, fixedName()), undefined, 256 * 1024 * 1024],
    [path.join(retained.directory, "control.json"), retained.config, 64 * 1024],
    [path.join(retained.directory, "payload.json"), retained.registry, 64 * 1024],
    [
      path.join(inputs.pair.preparation.prepared_root, "payload.json"),
      retained.registry,
      64 * 1024,
    ],
    [path.join(retained.directory, "verifier.stdout.json"), retained.stdout, 64 * 1024],
  ] as const) {
    active(retained.deadline);
    const bytes = await read(file, maximum);
    if (expected) assert.ok(bytes.equals(expected), "signature component retained bytes changed");
    else assert.equal(sha(bytes), retained.tool.sha256);
  }
  assert.ok(
    (await readNativeCapturedStream(retained.directory, "verifier.stderr.bin")).equals(
      retained.stderr,
    ),
  );
  active(retained.deadline);
  const report = inspectPublicSignatureControlReport(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(retained.stdout)),
    retained.expected,
  );
  return Object.freeze({
    directory: retained.directory,
    report,
    report_sha256: sha(retained.stdout),
    config_sha256: retained.expected.config_sha256,
    authority: "none" as const,
    native_acceptance: "not-established" as const,
  });
}

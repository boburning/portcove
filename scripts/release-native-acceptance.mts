import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { createGitHubRunner, GitHubApiClient } from "./github-api.mts";
import type { GitHubRestReader } from "./github-api.mts";
import { releaseCanonicalDigest } from "./release-canonical.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { isRecord } from "./runtime-values.mts";
import {
  inspectNativeReleaseQualification,
  nativeQualificationCheckName,
  nativePrepublicationProfile,
  inspectNativeQualificationJourney,
  inspectNativeQualificationCandidate,
  inspectNativeQualificationHarnessPath,
  inspectNativeQualificationAccount,
} from "./release-native-qualification-contract.mts";
import type { NativeReleaseQualification } from "./release-native-qualification-contract.mts";

const repository = "repos/boburning/portcove";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export type NativeQualificationExpectation = {
  schema_version: 1 | 2;
  native_prepublication_profile?: typeof nativePrepublicationProfile;
  check_id: number;
  native_app_id: number;
  semantic_app_id: number;
  classification_app_id: number;
  stage: NativeReleaseQualification["stage"];
  platform_label: NativeReleaseQualification["platform_label"];
  candidate: NativeReleaseQualification["candidate"];
  producer: Omit<NativeReleaseQualification["producer"], "started_at">;
  host: Pick<
    NativeReleaseQualification["host"],
    "machine_id_sha256" | "qualification_profile" | "minimum_platform" | "account"
  > & {
    engine: { name: string; minimum_version: string };
  };
  compatibility: NativeReleaseQualification["compatibility"];
  journey: NativeReleaseQualification["journey"];
};
type BoundReceipt = {
  directory: string;
  files: { path: string; bytes: number; sha256: string }[];
  expected: NativeQualificationExpectation;
  report: NativeReleaseQualification;
  check_identity: unknown;
  suite_identity: unknown;
  get: (route: string) => unknown;
  active: () => void;
};
const qualifications = new WeakMap<object, BoundReceipt>();
export type VerifiedNativeReleaseQualification = Readonly<
  NativeReleaseQualification & {
    check: { id: number; app_id: number; report_sha256: string; url: string };
    evidence_ids: readonly string[];
  }
>;
function exact(value: unknown, keys: string): asserts value is Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== keys)
    throw new Error("native qualification expectation schema differs");
}
function positive(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error("native qualification issuer/provider identity is invalid");
}
function bounded(value: unknown, maximum = 512): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    Array.from(value).some((v) => v.charCodeAt(0) < 32 || v.charCodeAt(0) === 127)
  )
    throw new Error("native qualification expectation text is invalid");
}
function digest(value: unknown, length = 64) {
  if (typeof value !== "string" || !new RegExp(`^[a-f0-9]{${length}}$`, "u").test(value))
    throw new Error("native qualification expected digest is invalid");
}
function version(value: unknown): bigint[] {
  bounded(value, 64);
  if (!/^[0-9]{1,10}(?:\.[0-9]{1,10}){1,3}$/u.test(value))
    throw new Error("observed native engine version is unavailable");
  return value.split(".").map((part) => BigInt(part));
}
export function inspectNativeQualificationExpectation(
  raw: unknown,
): NativeQualificationExpectation {
  const value: unknown = structuredClone(raw);
  exact(
    value,
    isRecord(value) && value.schema_version === 2
      ? "candidate,check_id,classification_app_id,compatibility,host,journey,native_app_id,native_prepublication_profile,platform_label,producer,schema_version,semantic_app_id,stage"
      : "candidate,check_id,classification_app_id,compatibility,host,journey,native_app_id,platform_label,producer,schema_version,semantic_app_id,stage",
  );
  if (
    Buffer.byteLength(JSON.stringify(value)) > 16 * 1024 ||
    (value.schema_version !== 1 && value.schema_version !== 2) ||
    !["payload-signing", "release-publication"].includes(String(value.stage)) ||
    !["windows-x86_64", "linux-x86_64"].includes(String(value.platform_label))
  )
    throw new Error("native qualification expected stage/platform is invalid");
  if (
    value.schema_version === 2 &&
    (value.stage !== "release-publication" ||
      value.native_prepublication_profile !== nativePrepublicationProfile)
  )
    throw new Error("native expected ratified prepublication profile differs");
  for (const key of [
    "check_id",
    "native_app_id",
    "semantic_app_id",
    "classification_app_id",
  ] as const)
    positive(value[key]);
  if (
    new Set([value.native_app_id, value.semantic_app_id, value.classification_app_id, 15368])
      .size !== 4
  )
    throw new Error(
      "native issuer must be distinct from semantic, classification and Actions issuers",
    );
  const candidate = (item: unknown) => {
    exact(item, "artifact_id,package,run_attempt,run_id,source_commit,source_tree");
    digest(item.source_commit, 40);
    digest(item.source_tree, 40);
    bounded(item.run_id, 20);
    if (!/^[1-9][0-9]{0,19}$/u.test(item.run_id))
      throw new Error("native candidate run identity is invalid");
    positive(item.run_attempt);
    positive(item.artifact_id);
    exact(item.package, "bytes,filename,sha256");
    positive(item.package.bytes);
    digest(item.package.sha256);
    bounded(item.package.filename, 192);
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(item.package.filename))
      throw new Error("native candidate path is unsafe");
  };
  candidate(value.candidate);
  exact(value.producer, "harness,invocation_id,source_commit,source_tree");
  digest(value.producer.invocation_id);
  digest(value.producer.source_commit, 40);
  digest(value.producer.source_tree, 40);
  exact(value.producer.harness, "path,sha256");
  digest(value.producer.harness.sha256);
  bounded(value.producer.harness.path, 192);
  inspectNativeQualificationHarnessPath(value.producer.harness.path);
  exact(value.host, "account,engine,machine_id_sha256,minimum_platform,qualification_profile");
  digest(value.host.machine_id_sha256);
  bounded(value.host.minimum_platform, 128);
  bounded(value.host.qualification_profile, 128);
  const expectedAccount = inspectNativeQualificationAccount(value.host.account);
  if (
    value.platform_label === "windows-x86_64"
      ? expectedAccount.kind !== "windows-sid"
      : !["linux-uid", "windows-wsl-uid"].includes(expectedAccount.kind)
  )
    throw new Error("native expected platform/account identity differs");
  exact(value.host.engine, "minimum_version,name");
  bounded(value.host.engine.name, 64);
  version(value.host.engine.minimum_version);
  exact(
    value.compatibility,
    "catalog_formats,cli_protocol,library,minimum_os_version,required_capabilities",
  );
  bounded(value.compatibility.minimum_os_version, 128);
  for (const [key, minimum] of [
    ["required_capabilities", 0],
    ["catalog_formats", 1],
  ] as const) {
    const entries = value.compatibility[key];
    if (
      !Array.isArray(entries) ||
      entries.length < minimum ||
      entries.length > 32 ||
      new Set(entries).size !== entries.length
    )
      throw new Error("native expected compatibility inventory differs");
    for (const entry of entries)
      if (key === "required_capabilities") bounded(entry, 128);
      else positive(entry);
  }
  const range = (rawRange: unknown) => {
    exact(rawRange, "max,min");
    positive(rawRange.min);
    positive(rawRange.max);
    if (rawRange.min > rawRange.max)
      throw new Error("native expected compatibility range is reversed");
  };
  range(value.compatibility.cli_protocol);
  exact(value.compatibility.library, "lock_protocol,read,write_schema");
  range(value.compatibility.library.read);
  positive(value.compatibility.library.write_schema);
  bounded(value.compatibility.library.lock_protocol, 128);
  inspectNativeQualificationJourney(
    value.journey,
    value.stage as NativeReleaseQualification["stage"],
    inspectNativeQualificationCandidate(value.candidate),
    value.schema_version === 2,
  );
  // Every member is explicitly validated above; the actual report inspector
  // additionally validates the complete observed fields before any receipt.
  return value as unknown as NativeQualificationExpectation;
}
export function prepareNativeQualificationCheck(raw: unknown) {
  const report = inspectNativeReleaseQualification(raw),
    reportSha = releaseCanonicalDigest(report);
  const summary = JSON.stringify({
    schema_version: report.schema_version,
    report_sha256: reportSha,
    report,
  });
  if (Buffer.byteLength(summary) > 64 * 1024) throw new Error("native Check summary exceeds bound");
  return {
    report,
    authority: "none" as const,
    qualification: "wire serialization only; no native capture or issuer authentication",
    body: {
      name: nativeQualificationCheckName,
      head_sha: report.candidate.source_commit,
      external_id: `portcove-native-qualification-v${report.schema_version}:${reportSha}`,
      status: "completed",
      conclusion: "success",
      // Checks' documented wire format has whole UTC seconds. The full native
      // timestamps stay unchanged inside the report and its canonical digest.
      started_at: report.producer.started_at.replace(/\.\d{3}Z$/u, "Z"),
      completed_at: report.runtime.teardown.completed_at.replace(/\.\d{3}Z$/u, "Z"),
      output: { title: nativeQualificationCheckName, summary },
    },
  };
}
function suiteIdentity(raw: unknown, expected: NativeQualificationExpectation) {
  if (
    !isRecord(raw) ||
    !isRecord(raw.app) ||
    raw.app.id !== expected.native_app_id ||
    raw.head_sha !== expected.candidate.source_commit ||
    !isRecord(raw.repository) ||
    raw.repository.id !== 1354613114 ||
    raw.repository.full_name !== "boburning/portcove"
  )
    throw new Error("native Check suite issuer/repository/source differs");
  positive(raw.id);
  return {
    id: raw.id,
    app_id: expected.native_app_id,
    head_sha: raw.head_sha,
    repository_id: raw.repository.id,
  };
}
function checkIdentity(raw: unknown, expected: NativeQualificationExpectation) {
  if (
    !isRecord(raw) ||
    raw.id !== expected.check_id ||
    !isRecord(raw.app) ||
    raw.app.id !== expected.native_app_id ||
    raw.head_sha !== expected.candidate.source_commit ||
    raw.name !== nativeQualificationCheckName ||
    raw.status !== "completed" ||
    raw.conclusion !== "success" ||
    !isRecord(raw.output) ||
    raw.output.title !== nativeQualificationCheckName ||
    typeof raw.output.summary !== "string" ||
    Buffer.byteLength(raw.output.summary) > 64 * 1024 ||
    !isRecord(raw.check_suite)
  )
    throw new Error("native Check producer/completion/source is not authenticated");
  positive(raw.check_suite.id);
  const summary: unknown = JSON.parse(raw.output.summary);
  exact(summary, "report,report_sha256,schema_version");
  const report = inspectNativeReleaseQualification(summary.report),
    prepared = prepareNativeQualificationCheck(report);
  if (
    summary.schema_version !== report.schema_version ||
    summary.report_sha256 !== releaseCanonicalDigest(report) ||
    raw.external_id !== prepared.body.external_id ||
    typeof raw.started_at !== "string" ||
    typeof raw.completed_at !== "string" ||
    Date.parse(raw.started_at) !== Date.parse(prepared.body.started_at) ||
    Date.parse(raw.completed_at) !== Date.parse(prepared.body.completed_at)
  )
    throw new Error("native Check exact capture identity differs");
  const { started_at: _invocationStart, ...producer } = report.producer;
  const projectedHost = {
    machine_id_sha256: report.host.machine_id_sha256,
    qualification_profile: report.host.qualification_profile,
    minimum_platform: report.host.minimum_platform,
    account: report.host.account,
  };
  const { engine, ...expectedHost } = expected.host;
  if (
    report.schema_version !== expected.schema_version ||
    report.native_prepublication_profile !== expected.native_prepublication_profile ||
    report.stage !== expected.stage ||
    report.platform_label !== expected.platform_label ||
    !isDeepStrictEqual(report.candidate, expected.candidate) ||
    !isDeepStrictEqual(producer, expected.producer) ||
    !isDeepStrictEqual(projectedHost, expectedHost) ||
    !isDeepStrictEqual(report.compatibility, expected.compatibility) ||
    !isDeepStrictEqual(report.journey, expected.journey) ||
    report.host.loaded_engine.name !== engine.name
  )
    throw new Error(
      "native capture does not bind independently expected package/host/stage inputs",
    );
  const actualVersion = version(report.host.loaded_engine.version),
    minimumVersion = version(engine.minimum_version);
  for (let index = 0; index < 4; index++) {
    const actual = actualVersion[index] ?? 0n,
      minimum = minimumVersion[index] ?? 0n;
    if (actual < minimum) throw new Error("native loaded engine is below the qualified floor");
    if (actual > minimum) break;
  }
  return {
    id: expected.check_id,
    suite_id: raw.check_suite.id,
    app_id: expected.native_app_id,
    name: raw.name,
    head_sha: raw.head_sha,
    external_id: raw.external_id,
    started_at: raw.started_at,
    completed_at: raw.completed_at,
    report_sha256: releaseCanonicalDigest(report),
    report,
  };
}

/** Read-only actual-provider collection. Injected boundaries exercise the same
 * checks and retained bytes but never receive a native acceptance brand. */
export async function collectNativeReleaseQualification(
  outputParent: string,
  rawExpected: unknown,
  options: {
    api?: GitHubRestReader;
    spawn?: NonNullable<Parameters<typeof createGitHubRunner>[0]>["spawn"];
    deadline?: number;
  } = {},
) {
  const injectedApi = options.api,
    injectedSpawn = options.spawn,
    deadline = options.deadline;
  const remaining = () => {
    if (deadline === undefined) return 15000;
    const left = Math.floor(deadline - performance.now());
    if (!Number.isFinite(deadline) || left < 1)
      throw new Error("native qualification phase deadline exhausted");
    return Math.min(15000, left);
  };
  remaining();
  const injected = injectedApi !== undefined || injectedSpawn !== undefined;
  const expected = inspectNativeQualificationExpectation(rawExpected);
  if (!path.isAbsolute(outputParent))
    throw new Error("native evidence output parent must be absolute");
  const directory = await mkdtemp(path.join(outputParent, "native-qualification-"));
  await chmod(directory, 0o700);
  const environment = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: directory,
    USERPROFILE: directory,
    TEMP: directory,
    TMP: directory,
    TMPDIR: directory,
    GH_CONFIG_DIR: path.join(directory, "gh"),
    GH_HOST: "github.com",
    GH_TOKEN: process.env.GH_TOKEN,
  };
  const runner = createGitHubRunner({
    cwd: directory,
    timeoutMs: 15000,
    maxBuffer: 512 * 1024,
    spawn: (command, args, settings) =>
      (injectedSpawn ?? spawnSync)(command, args, {
        ...settings,
        timeout: remaining(),
        env: environment,
      }),
  });
  const api =
    injectedApi ??
    new GitHubApiClient((args, input) => runner([...args, "--hostname", "github.com"], input));
  const get = (route: string) => {
    remaining();
    if (
      route !==
        `contents/${expected.producer.harness.path}?ref=${expected.producer.source_commit}` &&
      !/^check-runs\/[1-9][0-9]*$|^check-suites\/[1-9][0-9]*$|^git\/commits\/[a-f0-9]{40}$/u.test(
        route,
      )
    )
      throw new Error("native provider route is outside fixed read-only inputs");
    const response = api.request("GET", `${repository}/${route}`);
    remaining();
    if (response.status !== 200 || Buffer.byteLength(JSON.stringify(response.body)) > 512 * 1024)
      throw new Error("native provider readback is unavailable or oversized");
    return structuredClone(response.body);
  };
  const files: BoundReceipt["files"] = [];
  const retainBytes = async (name: string, bytes: Buffer) => {
    remaining();
    if (bytes.length < 1 || bytes.length > 512 * 1024)
      throw new Error("native retained proof exceeds bound");
    const filename = path.join(directory, name);
    await writeFile(filename, bytes, { flag: "wx", mode: 0o600 });
    files.push({ path: filename, bytes: bytes.length, sha256: hash(bytes) });
    remaining();
  };
  const retain = (name: string, value: unknown) =>
    retainBytes(name, Buffer.from(JSON.stringify(value)));
  let phase = "expected-inputs";
  try {
    await retain("expected.json", expected);
    phase = "native-check";
    const firstCheck = get(`check-runs/${expected.check_id}`);
    await retain("check-before.json", firstCheck);
    const check = checkIdentity(firstCheck, expected);
    const firstSuite = get(`check-suites/${check.suite_id}`);
    await retain("suite-before.json", firstSuite);
    const suite = suiteIdentity(firstSuite, expected);
    if (suite.id !== check.suite_id) throw new Error("native Check suite association differs");
    phase = "exact-producer-source";
    for (const [kind, source] of [
      ["producer", expected.producer],
      ["candidate", expected.candidate],
    ] as const) {
      const commit = get(`git/commits/${source.source_commit}`);
      await retain(`${kind}-source.json`, commit);
      if (
        !isRecord(commit) ||
        commit.sha !== source.source_commit ||
        !isRecord(commit.tree) ||
        commit.tree.sha !== source.source_tree
      )
        throw new Error("native producer/candidate source tree differs");
    }
    phase = "exact-harness-source";
    const harness = get(
      `contents/${expected.producer.harness.path}?ref=${expected.producer.source_commit}`,
    );
    await retain("harness-source.json", harness);
    if (
      !isRecord(harness) ||
      harness.type !== "file" ||
      harness.path !== expected.producer.harness.path ||
      harness.encoding !== "base64" ||
      typeof harness.content !== "string" ||
      harness.content.length > 350000 ||
      typeof harness.size !== "number" ||
      !Number.isSafeInteger(harness.size) ||
      harness.size < 1 ||
      harness.size > 256 * 1024 ||
      typeof harness.sha !== "string" ||
      !/^[a-f0-9]{40}$/u.test(harness.sha)
    )
      throw new Error("native exact harness source content is incomplete");
    const encoded = harness.content.replace(/\r?\n/gu, "");
    const bytes = Buffer.from(encoded, "base64");
    if (
      bytes.toString("base64") !== encoded ||
      bytes.length !== harness.size ||
      hash(bytes) !== expected.producer.harness.sha256 ||
      createHash("sha1")
        .update(Buffer.from(`blob ${bytes.length}\0`))
        .update(bytes)
        .digest("hex") !== harness.sha
    )
      throw new Error("native exact harness bytes/source blob differ");
    await retainBytes("harness-source.ps1.txt", bytes);
    phase = "provider-bracket";
    const finalCheck = get(`check-runs/${expected.check_id}`),
      finalSuite = get(`check-suites/${check.suite_id}`);
    await retain("check-after.json", finalCheck);
    await retain("suite-after.json", finalSuite);
    if (
      !isDeepStrictEqual(checkIdentity(finalCheck, expected), check) ||
      !isDeepStrictEqual(suiteIdentity(finalSuite, expected), suite)
    )
      throw new Error("native Check proof changed during acquisition");
    await retain("report.json", check.report);
    const receipt = Object.freeze({
      kind: "verified-native-release-qualification" as const,
      evidence_scope: injected ? ("injected-provider" as const) : ("github.com" as const),
      stage: check.report.stage,
      check_id: check.id,
      report_sha256: check.report_sha256,
      directory,
      authority: "none" as const,
    });
    await retain("receipt.json", receipt);
    if (!injected)
      qualifications.set(receipt, {
        directory,
        files,
        expected,
        report: check.report,
        check_identity: check,
        suite_identity: suite,
        get,
        active: () => {
          remaining();
        },
      });
    return receipt;
  } catch {
    await writeFile(
      path.join(directory, "failure.json"),
      JSON.stringify({ phase, authority: "none", status: "refused" }),
      { flag: "wx", mode: 0o600 },
    );
    throw new Error(`native qualification refused; retain ${directory}`);
  }
}

export async function verifiedNativeReleaseQualification(
  receipt: object,
): Promise<VerifiedNativeReleaseQualification> {
  const bound = qualifications.get(receipt);
  if (!bound)
    throw new Error("native qualification was not authenticated by this actual provider process");
  bound.active();
  for (const file of bound.files) {
    const bytes = await readControllerToolFile(file.path, 512 * 1024);
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256)
      throw new Error("native retained proof changed");
    bound.active();
  }
  const check = checkIdentity(bound.get(`check-runs/${bound.expected.check_id}`), bound.expected);
  const suite = suiteIdentity(bound.get(`check-suites/${check.suite_id}`), bound.expected);
  if (
    !isDeepStrictEqual(check, bound.check_identity) ||
    !isDeepStrictEqual(suite, bound.suite_identity)
  )
    throw new Error("native qualification changed before consumption");
  const result = structuredClone({
    ...bound.report,
    check: {
      id: check.id,
      app_id: check.app_id,
      report_sha256: check.report_sha256,
      url: `https://api.github.com/repos/boburning/portcove/check-runs/${check.id}`,
    },
    evidence_ids: [
      `native-check:${check.id}:${check.report_sha256}`,
      `native-capture:${bound.report.runtime.capture_sha256}`,
      `native-teardown:${bound.report.runtime.teardown.capture_sha256}`,
    ],
  });
  const freeze = (value: unknown): void => {
    if (value && typeof value === "object") {
      for (const member of Object.values(value)) freeze(member);
      Object.freeze(value);
    }
  };
  freeze(result);
  bound.active();
  return result;
}

/** Actual hosted transport authentication. Wire parsing is deliberately separate
 * from this private, same-process receipt. No imported or injected proof can
 * acquire a native admission brand. This does not execute the native producer. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdtemp, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { createGitHubRunner, GitHubApiClient } from "./github-api.mts";
import type { GitHubRestReader } from "./github-api.mts";
import { verifyControllerArtifactVerification } from "./github-controller-attestation.mts";
import { productionControllerWorkflow } from "./production-controller-admission.mts";
import {
  verifyHistoricalHostedNativeJob,
  verifyHostedNativePhaseJob,
} from "./release-checkpoint-job-identity.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { readOnlyReleaseChildEnvironment } from "./release-readonly-child-environment.mts";
import {
  hostedNativePredicateType,
  hostedNativeProofLimits,
  inspectHostedNativeProofFiles,
  inspectHostedNativeCustodyBundle,
} from "./release-hosted-native-proof-contract.mts";
import type { HostedNativeProofFiles } from "./release-hosted-native-proof-contract.mts";
import type { NativeReleaseQualification } from "./release-native-qualification-contract.mts";
import { isRecord } from "./runtime-values.mts";
import { inspectSelectedPublicationAuthorityConfiguration } from "./release-authority-configuration.mts";

type Prepared = ReturnType<typeof inspectHostedNativeProofFiles>;
export type HostedNativeQualificationExpectation = Pick<
  NativeReleaseQualification,
  "platform_label" | "stage" | "candidate" | "journey"
> & { producer: Prepared["producer"] };
export type VerifiedHostedNativeQualification = NativeReleaseQualification & {
  check?: never;
  hosted_job: Prepared["producer"] & {
    subject_sha256: string;
    report_sha256: string;
    bundle_sha256: string;
  };
  evidence_ids: readonly string[];
};
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const keys = ["subject", "report", "capture", "bundle"] as const;
type Retained = {
  prepared: Prepared;
  authorities: unknown;
  expected: HostedNativeQualificationExpectation;
  filenames: Record<(typeof keys)[number], string>;
  active: () => void;
  deadline: number;
  observeJob: () => ReturnType<typeof verifyHistoricalHostedNativeJob>;
  job: ReturnType<typeof verifyHistoricalHostedNativeJob>;
  stopped: boolean;
};
const receipts = new WeakMap<object, Retained>();
const historicalReceipts = new WeakMap<object, Retained>();
const continuityReceipts = new WeakMap<object, Retained>();
const custodyReceipts = new WeakMap<object, { bytes: Buffer; receipts: readonly object[] }>();

function association(prepared: Prepared, expected: HostedNativeQualificationExpectation) {
  if (
    !isRecord(expected) ||
    Object.keys(expected).sort().join(",") !== "candidate,journey,platform_label,producer,stage" ||
    Buffer.byteLength(JSON.stringify(expected)) > 16384 ||
    !isDeepStrictEqual(
      {
        platform_label: prepared.report.platform_label,
        stage: prepared.report.stage,
        candidate: prepared.report.candidate,
        journey: prepared.report.journey,
      },
      {
        platform_label: expected.platform_label,
        stage: expected.stage,
        candidate: expected.candidate,
        journey: expected.journey,
      },
    )
  )
    throw new Error("hosted native proof differs from independently expected opportunity");
}

function instant(raw: unknown) {
  if (
    typeof raw !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/u.test(raw) ||
    !Number.isFinite(Date.parse(raw)) ||
    new Date(raw).toISOString().slice(0, 19) !== raw.slice(0, 19)
  )
    throw new Error("hosted native verified timestamp unavailable");
  return Date.parse(raw);
}

type HostedNativeProofArguments = [
  directory: string,
  rawAuthorities: unknown,
  rawExpected: HostedNativeQualificationExpectation,
  rawFiles: HostedNativeProofFiles,
  deadline: number,
  options?: {
    attestation?: NonNullable<Parameters<typeof verifyControllerArtifactVerification>[5]>;
    api?: GitHubRestReader;
  },
];
/** Current settled stage only; the original provider job may remain alive for
 * subsequent phases. This is never terminal same-client journey acceptance. */
export function collectHostedNativeReleaseQualification(...args: HostedNativeProofArguments) {
  return collectHostedNativeProof("current", ...args);
}

/** Original signature/source/job verification only. Even the default successful
 * route cannot mint a current qualification or private custody preparation. */
export function collectHistoricalHostedNativeQualification(...args: HostedNativeProofArguments) {
  return collectHostedNativeProof("historical", ...args);
}

/** Authenticated Server continuity only. This never mints a native admission
 * or minimum-client receipt, including through the historical/custody routes. */
export function collectHostedWindowsContinuity(...args: HostedNativeProofArguments) {
  return collectHostedNativeProof("continuity", ...args);
}

async function collectHostedNativeProof(
  purpose: "current" | "historical" | "continuity",
  directory: string,
  rawAuthorities: unknown,
  rawExpected: HostedNativeQualificationExpectation,
  rawFiles: HostedNativeProofFiles,
  deadline: number,
  options: {
    attestation?: NonNullable<Parameters<typeof verifyControllerArtifactVerification>[5]>;
    api?: GitHubRestReader;
  } = {},
) {
  // All caller-controlled inputs are snapshotted before the first await.
  const authorities: unknown = structuredClone(rawAuthorities);
  const expected = structuredClone(rawExpected);
  const prepared = inspectHostedNativeProofFiles(rawFiles, authorities, expected.producer);
  association(prepared, expected);
  if ((prepared.qualification_scope === "continuity-only") !== (purpose === "continuity"))
    throw new Error(
      "Server continuity cannot supply native/client-minimum acceptance; separate Windows client qualification required",
    );
  const injected = options.attestation !== undefined || options.api !== undefined;
  const attestation =
    options.attestation === undefined
      ? undefined
      : {
          ...options.attestation,
          ...(options.attestation.environment
            ? { environment: { ...options.attestation.environment } }
            : {}),
        };
  const environment = attestation?.environment ?? readOnlyReleaseChildEnvironment();
  if (!environment)
    throw new Error("hosted native verification requires isolated reader credentials");
  const active = () => {
    if (!Number.isFinite(deadline) || performance.now() >= deadline)
      throw new Error("hosted native original deadline exhausted");
  };
  active();
  if (deadline - performance.now() > 120000)
    throw new Error("hosted native verification requires a bounded original deadline");
  const suppliedApi = options.api;
  if (
    !path.isAbsolute(directory) ||
    (await realpath(directory)) !== path.resolve(directory) ||
    !(await lstat(directory)).isDirectory()
  )
    throw new Error("hosted native verification requires a canonical owned parent");
  active();
  const capture = await mkdtemp(path.join(directory, "hosted-native-verification-"));
  await chmod(capture, 0o700);
  const filenames = Object.fromEntries(
    keys.map((key) => [key, path.join(capture, `${key}.json`)]),
  ) as Retained["filenames"];
  const baseApi =
    suppliedApi ??
    new GitHubApiClient((args, input) => {
      active();
      return createGitHubRunner({
        cwd: capture,
        spawn: (command, values, settings) =>
          spawnSync(command, values, { ...settings, env: environment }),
        maxBuffer: 2 * 1024 * 1024,
        timeoutMs: Math.min(30000, Math.ceil(deadline - performance.now())),
      })([...args, "--hostname", "github.com"], input);
    });
  let requests = 0;
  const api: GitHubRestReader = {
    request(method, route) {
      active();
      if (method !== "GET" || ++requests > 50)
        throw new Error("hosted native provider read bound exhausted");
      const result = baseApi.request(method, route);
      active();
      if (result.status !== 200) throw new Error("hosted native provider read unavailable");
      return result;
    },
  };
  const get = (suffix: string) => api.request("GET", `repos/boburning/portcove/${suffix}`).body;
  const retain = async (name: string, value: unknown) => {
    await writeFile(path.join(capture, name), JSON.stringify(value), { flag: "wx", mode: 0o600 });
    active();
  };
  const readback = async () => {
    for (const key of keys) {
      const bytes = await readControllerToolFile(filenames[key], hostedNativeProofLimits[key]);
      if (!bytes.equals(prepared.files[key]))
        throw new Error("hosted native retained proof changed");
      active();
    }
  };
  let phase = "capture";
  try {
    for (const key of keys) {
      await writeFile(filenames[key], prepared.files[key], { flag: "wx", mode: 0o600 });
      active();
    }
    await retain("expected.json", expected);
    phase = "source";
    for (const [name, source] of [
      ["producer", prepared.report.producer],
      ["candidate", prepared.report.candidate],
    ] as const) {
      const commit = get(`git/commits/${source.source_commit}`);
      await retain(`${name}-source.json`, commit);
      if (
        !isRecord(commit) ||
        commit.sha !== source.source_commit ||
        !isRecord(commit.tree) ||
        commit.tree.sha !== source.source_tree
      )
        throw new Error("hosted native source tree differs");
    }
    for (const [name, filename, revision, digest, maximum] of [
      [
        "harness",
        prepared.report.producer.harness.path,
        prepared.report.producer.source_commit,
        prepared.report.producer.harness.sha256,
        256 * 1024,
      ],
      [
        "workflow",
        productionControllerWorkflow,
        prepared.producer.controller_revision,
        prepared.producer.workflow_sha256,
        65536,
      ],
    ] as const) {
      const item = get(`contents/${filename}?ref=${revision}`);
      await retain(`${name}-source.json`, item);
      if (
        !isRecord(item) ||
        item.type !== "file" ||
        item.path !== filename ||
        item.encoding !== "base64" ||
        typeof item.content !== "string" ||
        item.content.length > 350000 ||
        typeof item.size !== "number" ||
        !Number.isSafeInteger(item.size) ||
        item.size < 1 ||
        item.size > maximum ||
        typeof item.sha !== "string" ||
        !/^[a-f0-9]{40}$/u.test(item.sha)
      )
        throw new Error("hosted native source file incomplete");
      const encoded = item.content.replace(/\r?\n/gu, ""),
        bytes = Buffer.from(encoded, "base64");
      if (
        bytes.toString("base64") !== encoded ||
        bytes.length !== item.size ||
        hash(bytes) !== digest ||
        createHash("sha1")
          .update(Buffer.from(`blob ${bytes.length}\0`))
          .update(bytes)
          .digest("hex") !== item.sha
      )
        throw new Error("hosted native exact source bytes differ");
    }
    phase = "signature";
    const verified = verifyControllerArtifactVerification(
      capture,
      filenames.subject,
      filenames.bundle,
      prepared.producer,
      hostedNativePredicateType,
      { ...attestation, environment, deadline },
    );
    if (
      !isDeepStrictEqual(verified.statement, prepared.statement) ||
      verified.verifiedTimestamps.length > 8
    )
      throw new Error("hosted native verified statement or timestamp bound differs");
    const times = verified.verifiedTimestamps.map((value: unknown) =>
      instant(isRecord(value) ? value.timestamp : null),
    );
    const observeJob = () =>
      (purpose !== "historical" ? verifyHostedNativePhaseJob : verifyHistoricalHostedNativeJob)(
        prepared.report.platform_label,
        prepared.producer,
        Math.max(...times),
        { cwd: capture, deadline, api },
      );
    phase = purpose !== "historical" ? "settled-phase-job" : "historical-job";
    const job = observeJob();
    const start = instant(prepared.report.runtime.started_at),
      end = instant(prepared.report.runtime.teardown.completed_at);
    if (
      instant(prepared.report.producer.started_at) < job.witnessed_interval.start ||
      start < job.witnessed_interval.start ||
      end > job.witnessed_interval.end ||
      times.some(
        (time) =>
          time < end || time < job.witnessed_interval.start || time > job.witnessed_interval.end,
      )
    )
      throw new Error("hosted native runtime or signing outside original job settlement");
    phase = "readback";
    await readback();
    const receipt = Object.freeze({
      kind:
        purpose === "continuity"
          ? "verified-hosted-windows-continuity"
          : purpose === "current"
            ? "verified-hosted-native-settled-phase"
            : "verified-hosted-native-history",
      evidence_scope: injected ? "injected-provider" : "github.com",
      capture_directory: capture,
      authority: "none",
      journey_completion: "not-established",
    });
    await retain("verification.json", {
      producer: prepared.producer,
      subject_sha256: prepared.subject_sha256,
      report_sha256: prepared.report_sha256,
      bundle_sha256: hash(prepared.files.bundle),
      verified_timestamps: times,
      job,
      evidence_scope: receipt.evidence_scope,
      custody_scope: purpose !== "historical" ? "signed-stage-witness" : "completed-job-history",
      minimum_client_acceptance:
        purpose === "continuity" ? "not-established" : "separate-native-stage",
      journey_completion: "not-established",
      authority: "none",
    });
    if (!injected)
      (purpose === "continuity"
        ? continuityReceipts
        : purpose === "current"
          ? receipts
          : historicalReceipts
      ).set(receipt, {
        prepared,
        authorities,
        expected,
        filenames,
        active,
        deadline,
        observeJob,
        job,
        stopped: false,
      });
    return receipt;
  } catch {
    await writeFile(
      path.join(capture, "failure.json"),
      JSON.stringify({ phase, status: "refused", authority: "none" }),
      { flag: "wx", mode: 0o600 },
    );
    throw new Error(`hosted native qualification refused during ${phase}; retain ${capture}`);
  }
}

/** Undefined means this is not our private receipt; callers may try the legacy
 * App transport. Injected and deserialized receipts never match this WeakMap. */
export async function verifiedHostedNativeReleaseQualification(
  receipt: object,
): Promise<VerifiedHostedNativeQualification | undefined> {
  const bound = receipts.get(receipt);
  if (!bound) return undefined;
  return readBoundHostedNativeQualification(bound);
}

export async function verifiedHostedWindowsContinuity(receipt: object) {
  const bound = continuityReceipts.get(receipt);
  if (!bound) return undefined;
  try {
    const observation = await readBoundHostedNativeQualification(bound);
    const result = Object.freeze({
      observation,
      minimum_client_acceptance: "not-established" as const,
      journey_completion: "not-established" as const,
      authority: "none" as const,
    });
    assertOriginalHostedNativeActive(bound);
    return result;
  } catch (error) {
    bound.stopped = true;
    throw error;
  }
}

/** Separate historical receipt namespace. These data cannot be passed through
 * the current native admission or archival getter, including after cloning. */
export async function verifiedHistoricalHostedNativeQualification(
  receipt: object,
): Promise<VerifiedHostedNativeQualification | undefined> {
  const bound = historicalReceipts.get(receipt);
  if (!bound) return undefined;
  return readBoundHostedNativeQualification(bound);
}

async function readBoundHostedNativeQualification(bound: Retained) {
  if (bound.stopped) throw new Error("hosted native original proof is permanently stopped");
  try {
    return await readActiveBoundHostedNativeQualification(bound);
  } catch (error) {
    // Preserve original files/effects; a later provider response cannot revive
    // an original receipt that already observed failure, drift or expiry.
    bound.stopped = true;
    throw error;
  }
}

function assertOriginalHostedNativeActive(bound: Retained) {
  if (bound.stopped) throw new Error("hosted native original proof is permanently stopped");
  bound.active();
}

async function readActiveBoundHostedNativeQualification(bound: Retained) {
  assertOriginalHostedNativeActive(bound);
  const files = {} as HostedNativeProofFiles;
  for (const key of keys) {
    files[key] = await readControllerToolFile(bound.filenames[key], hostedNativeProofLimits[key]);
    if (!files[key].equals(bound.prepared.files[key]))
      throw new Error("hosted native retained proof changed");
    assertOriginalHostedNativeActive(bound);
  }
  const prepared = inspectHostedNativeProofFiles(files, bound.authorities, bound.expected.producer);
  association(prepared, bound.expected);
  const observed = bound.observeJob();
  if (
    !isDeepStrictEqual(observed.witnessed_interval, bound.job.witnessed_interval) ||
    (bound.job.completed_at !== null && bound.job.completed_at !== observed.completed_at)
  )
    throw new Error("hosted native job changed before consumption");
  // Allow only live -> completed-success, never a return to live or a changed
  // terminal completion time hidden behind the same signed witness interval.
  bound.job = observed;
  const job = {
    ...prepared.producer,
    subject_sha256: prepared.subject_sha256,
    report_sha256: prepared.report_sha256,
    bundle_sha256: hash(files.bundle),
  };
  const result = structuredClone({
    ...prepared.report,
    hosted_job: job,
    evidence_ids: [
      `native-job:${job.run_id}:${job.run_attempt}:${job.job_id}:${job.check_run_id}:${job.subject_sha256}`,
      `native-report:${job.report_sha256}`,
      `native-capture:${prepared.report.runtime.capture_sha256}`,
      `native-teardown:${prepared.report.runtime.teardown.capture_sha256}`,
    ],
  });
  const freeze = (value: unknown): void => {
    if (value && typeof value === "object") {
      for (const item of Object.values(value)) freeze(item);
      Object.freeze(value);
    }
  };
  freeze(result);
  assertOriginalHostedNativeActive(bound);
  return result;
}

/** Prepare original bytes only from two actual private native receipts. This
 * does not publish them, reserve storage or establish durable remote custody. */
export async function prepareHostedNativeCustody(rawReceipts: readonly object[]) {
  const pair = (value: unknown): value is readonly object[] =>
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((entry: unknown) => typeof entry === "object" && entry !== null);
  if (!pair(rawReceipts) || rawReceipts[0] === rawReceipts[1])
    throw new Error("actual separate hosted native pair required for custody");
  const captured = [...rawReceipts];
  const proofs = [];
  for (const receipt of captured) {
    const report = await verifiedHostedNativeReleaseQualification(receipt),
      bound = receipts.get(receipt);
    if (!report || !bound)
      throw new Error("actual private hosted native pair required for custody");
    proofs.push({ report, bound });
  }
  proofs.sort((a, b) => a.report.platform_label.localeCompare(b.report.platform_label));
  if (!isDeepStrictEqual(proofs[0]!.bound.authorities, proofs[1]!.bound.authorities))
    throw new Error("hosted native custody configuration pair differs");
  const bytes = Buffer.from(
    JSON.stringify({
      schema_version: 1,
      purpose: "hosted-native-custody",
      configuration: inspectSelectedPublicationAuthorityConfiguration(proofs[0]!.bound.authorities),
      stage: proofs[0]!.report.stage,
      proofs: proofs.map(({ report, bound }) => ({
        platform_label: report.platform_label,
        producer: bound.prepared.producer,
        files: Object.fromEntries(
          keys.map((key) => [key, bound.prepared.files[key].toString("base64")]),
        ),
      })),
    }),
  );
  const checked = inspectHostedNativeCustodyBundle(bytes);
  for (const { bound } of proofs) assertOriginalHostedNativeActive(bound);
  const receipt = Object.freeze({
    kind: "prepared-hosted-native-custody",
    bytes: bytes.length,
    sha256: checked.sha256,
    stage: checked.stage,
    durable_custody: "not-established",
    authority: "none",
  });
  custodyReceipts.set(receipt, { bytes: Buffer.from(bytes), receipts: captured });
  return receipt;
}

/** Raw bytes/metadata cannot request checkpoint signing or archival. Recheck
 * both original private proofs and their original deadlines before handoff. */
export async function requirePreparedHostedNativeCustody(receipt: object, deadline?: number) {
  const current = () => {
    if (deadline !== undefined && (!Number.isFinite(deadline) || performance.now() >= deadline))
      throw new Error("native custody caller original deadline exhausted");
  };
  current();
  const retained = custodyReceipts.get(receipt);
  if (!retained) throw new Error("actual prepared hosted native custody required");
  for (const proof of retained.receipts) {
    if (!(await verifiedHostedNativeReleaseQualification(proof)))
      throw new Error("actual original native custody proof unavailable");
    current();
  }
  const checked = inspectHostedNativeCustodyBundle(retained.bytes);
  // The second awaited verification may consume the first proof's remaining
  // lifetime. Recheck every original clock after all awaits AND parsing.
  for (const proof of retained.receipts) {
    const bound = receipts.get(proof);
    if (!bound) throw new Error("actual original native custody proof unavailable");
    assertOriginalHostedNativeActive(bound);
  }
  const original = retained.receipts.map((proof) => receipts.get(proof)!);
  current();
  return {
    ...checked,
    deadline: Math.min(...original.map((proof) => proof.deadline)),
    assertCurrent: () => {
      for (const proof of original) assertOriginalHostedNativeActive(proof);
    },
  };
}

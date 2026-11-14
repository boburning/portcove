/**
 * Release-content source for the #4129 maintenance inventory (#5353).
 *
 * Consumes the retained report of the latest successful scheduled `main` run of
 * the release-content scan, bound by run identity and artifact digest. The scan
 * keeps its authority: a finding is review evidence for a reviewed catalog
 * hold, never a hold. This projection keeps only stable finding facts, so a
 * reused package stays quiet in changes-only storage.
 */
import { createHash } from "node:crypto";
import { MaintenanceStoreError } from "./maintenance-store.mts";
import { zipJsonEntry } from "./maintenance-release-health.mts";
import {
  DEFERRED_UNSCANNED,
  EVIDENCE_URL,
  PERSISTENT_UNSCANNED,
  SIGNAL_CAP,
  targetsDigest,
} from "./release-content-scan.mts";

const repository = "boburning/portcove";
// The maintained in-memory artifact transfer accepts archives up to 8 MiB.
const reportLimit = 8 * 1024 * 1024;
const portIdPattern = /^[a-z0-9][a-z0-9-]{0,127}$/u;

export interface ReleaseContentInput {
  revision: string;
  report: unknown;
}

/**
 * The scan's own not-scanned codes. Deferred targets are retried by a later
 * run, so their port is a coverage gap; a persistent code is deterministic for
 * the same release and limits, so it is a stored fact of the port.
 */
const deferredCodes: readonly string[] = DEFERRED_UNSCANNED;
const persistentCodes: readonly string[] = PERSISTENT_UNSCANNED;

export interface ContentSignalFact {
  path: string;
  kind: string;
  reason: string;
}

/** One flagged package, by the fields that identify it and its evidence. */
export interface ContentFinding {
  platform: string;
  repository: string;
  tag: string;
  asset: string;
  sha256: string;
  rules: number;
  /** At most the scan's signal cap, sorted; `signal_count` is the true total. */
  signals: ContentSignalFact[];
  signal_count: number;
  /** The reviewed accounting that dismisses this exact package, when one does. */
  accounted?: { reason: string; evidence: string };
}

/** A stored `port:<id>` fact. */
export interface ReleaseContentFact {
  findings: ContentFinding[];
  /** Targets no run scans under the current limits, with the scan's code. */
  unscannable: { platform: string; code: string }[];
}

/** A port some of whose targets a later run scans; carries what this report found. */
export interface ReleaseContentGap {
  subject_key: string;
  code: "release-content-deferred";
  message: string;
  deferred: { platform: string; code: string }[];
  findings: ContentFinding[];
  /** Persistent not-scanned targets this report already has for the port. */
  unscannable: { platform: string; code: string }[];
}

const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const unsupported = (detail: string) =>
  new MaintenanceStoreError(`Unsupported release-content report: ${detail}`);
const byText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
const targetOf = (value: Record<string, unknown>, field: string) => {
  if (!text(value.id) || !portIdPattern.test(value.id) || !text(value.platform))
    throw unsupported(`${field} entry has no valid id and platform`);
  return { id: value.id, platform: value.platform };
};
const records = (value: unknown, field: string) => {
  if (!Array.isArray(value) || !value.every((item) => item && typeof item === "object"))
    throw unsupported(`${field} is not a list of records`);
  return value as Record<string, unknown>[];
};

function finding(record: Record<string, unknown>): ContentFinding {
  const signals = records(record.signals, "findings[].signals");
  const count = record.signal_count;
  if (
    !Number.isSafeInteger(count) ||
    (count as number) < signals.length ||
    signals.length > SIGNAL_CAP ||
    ((count as number) > signals.length && signals.length !== SIGNAL_CAP)
  )
    throw unsupported("a finding's signal count does not match its capped signals");
  const accounted = record.accounted as Record<string, unknown> | undefined;
  if (
    accounted !== undefined &&
    (!accounted ||
      typeof accounted !== "object" ||
      !text(accounted.reason) ||
      typeof accounted.evidence !== "string" ||
      !EVIDENCE_URL.test(accounted.evidence))
  )
    throw unsupported("a finding's accounting lacks its reason or reviewed evidence");
  if (
    !text(record.repository) ||
    !text(record.tag) ||
    !text(record.asset) ||
    typeof record.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.sha256) ||
    !Number.isSafeInteger(record.rules) ||
    !signals.length ||
    !signals.every(
      (signal) => text(signal.path) && text(signal.kind) && typeof signal.reason === "string",
    )
  )
    throw unsupported("a finding lacks its package identity or signals");
  return {
    platform: String(record.platform),
    repository: record.repository,
    tag: record.tag,
    asset: record.asset,
    sha256: record.sha256,
    rules: record.rules as number,
    signals: signals
      .map(({ path, kind, reason }) => ({
        path: String(path),
        kind: String(kind),
        reason: String(reason),
      }))
      .sort((left, right) => byText(left.path, right.path) || byText(left.kind, right.kind)),
    signal_count: count as number,
    ...(accounted
      ? { accounted: { reason: String(accounted.reason), evidence: String(accounted.evidence) } }
      : {}),
  };
}

const findingOrder = (left: ContentFinding, right: ContentFinding) =>
  byText(left.platform, right.platform) ||
  byText(left.asset, right.asset) ||
  byText(left.sha256, right.sha256);

/** Per-port release-content facts and coverage from one scan report. */
export function releaseContentFacts(report: unknown) {
  const value = (report ?? {}) as Record<string, unknown>;
  if (value.format_version !== 3 || !Number.isSafeInteger(value.reused))
    throw unsupported("format_version or reused count");
  // The denominator is the scan's own target count, never the lists it must cover.
  const targets = value.targets;
  if (!Number.isSafeInteger(targets) || (targets as number) < 1)
    throw unsupported("the report declares no scan targets");
  if (typeof value.targets_sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(value.targets_sha256))
    throw unsupported("the report does not bind its target list");
  const scanned = records(value.scanned, "scanned");
  const reused = records(value.reused_targets, "reused_targets");
  const unscanned = records(value.unscanned, "unscanned");
  const flagged = records(value.findings, "findings");
  if (reused.length !== value.reused) throw unsupported("reused_targets do not match reused");
  // Every target the scan considered is exactly one of scanned, reused or not scanned.
  const ports = new Map<string, Set<string>>();
  const account = (target: { id: string; platform: string }) => {
    const platforms = ports.get(target.id) ?? new Set<string>();
    if (platforms.has(target.platform))
      throw unsupported(`target ${target.id} (${target.platform}) is listed twice`);
    ports.set(target.id, platforms.add(target.platform));
  };
  // Each scanned or reused package, so a finding must name exactly the package it flags.
  const packages = new Map<
    string,
    { key: string; tag: string; asset: string; sha256: string; flagged: boolean | null }
  >();
  for (const [list, field] of [
    [scanned, "scanned"],
    [reused, "reused_targets"],
  ] as const)
    for (const record of list) {
      const target = targetOf(record, field);
      account(target);
      if (
        !text(record.key) ||
        !text(record.tag) ||
        !text(record.asset) ||
        typeof record.sha256 !== "string" ||
        !/^[0-9a-f]{64}$/u.test(record.sha256)
      )
        throw unsupported(`${field} entry lacks its package identity`);
      if (field === "scanned" && !Array.isArray(record.signals))
        throw unsupported("a scanned record has no signals list");
      packages.set(`${target.id}\t${target.platform}`, {
        key: record.key,
        tag: record.tag,
        asset: record.asset,
        sha256: record.sha256,
        flagged: field === "scanned" ? (record.signals as unknown[]).length > 0 : null,
      });
    }
  const deferred = new Map<string, { platform: string; code: string }[]>();
  const unscannable = new Map<string, { platform: string; code: string }[]>();
  for (const entry of unscanned) {
    const target = targetOf(entry, "unscanned");
    account(target);
    const code = String(entry.code);
    const into = deferredCodes.includes(code)
      ? deferred
      : persistentCodes.includes(code)
        ? unscannable
        : null;
    if (!into) throw unsupported(`unknown not-scanned code ${code}`);
    into.set(target.id, [...(into.get(target.id) ?? []), { platform: target.platform, code }]);
  }
  const findings = new Map<string, ContentFinding[]>();
  const found = new Set<string>();
  for (const record of flagged) {
    const target = targetOf(record, "findings");
    const at = `${target.id}\t${target.platform}`;
    const flaggedPackage = packages.get(at);
    if (!flaggedPackage)
      throw unsupported(`finding for ${target.id} (${target.platform}) has no scanned target`);
    if (found.has(at))
      throw unsupported(`target ${target.id} (${target.platform}) has two findings`);
    found.add(at);
    if (
      record.key !== flaggedPackage.key ||
      record.tag !== flaggedPackage.tag ||
      record.asset !== flaggedPackage.asset ||
      record.sha256 !== flaggedPackage.sha256
    )
      throw unsupported(
        `finding for ${target.id} (${target.platform}) differs from its scanned or reused package`,
      );
    if (flaggedPackage.flagged === false)
      throw unsupported(`finding for ${target.id} (${target.platform}) has a clean scanned record`);
    findings.set(target.id, [...(findings.get(target.id) ?? []), finding(record)]);
  }
  for (const [at, { flagged: hasSignals }] of packages)
    if (hasSignals && !found.has(at))
      throw unsupported(`scanned record ${at.replace("\t", " (")}) has signals but no finding`);
  const ordered = (list: { platform: string; code: string }[] = []) =>
    list
      .map(({ platform, code }) => ({ platform, code }))
      .sort((left, right) => byText(left.platform, right.platform));
  const facts = new Map<string, ReleaseContentFact>();
  const gaps: ReleaseContentGap[] = [];
  for (const id of [...ports.keys()].sort(byText)) {
    const portFindings = (findings.get(id) ?? []).sort(findingOrder);
    const pending = ordered(deferred.get(id));
    if (pending.length)
      // A finding stays visible from the gap; the port's stored fact waits for every target.
      gaps.push({
        subject_key: `port:${id}`,
        code: "release-content-deferred",
        message: `Not every release target was scanned in this report (${pending
          .map(({ platform, code }) => `${platform}: ${code}`)
          .join(", ")}); prior facts stay current.`,
        deferred: pending,
        findings: portFindings,
        unscannable: ordered(unscannable.get(id)),
      });
    else
      facts.set(`port:${id}`, {
        findings: portFindings,
        unscannable: ordered(unscannable.get(id)),
      });
  }
  const accounted = [...ports].flatMap(([id, platforms]) =>
    [...platforms].map((platform) => ({ id, platform })),
  );
  if (accounted.length !== targets || targetsDigest(accounted) !== value.targets_sha256)
    throw unsupported(
      `scanned, reused and not-scanned entries cover ${accounted.length} of ${String(targets)} targets or differ from the target list`,
    );
  return { expected: ports.size, facts, gaps };
}

/** The latest successful scheduled main scan report, read-only. */
export async function readReleaseContent(): Promise<ReleaseContentInput> {
  const { createGitHubClient } = await import("./github-client.mts");
  const { localDeveloperCredential } = await import("./github-cli.mts");
  const { downloadGitHubArtifactArchive } = await import("./github-artifact-download.mts");
  const deadline = performance.now() + 120_000;
  const credential = localDeveloperCredential({
    deadline,
    command: process.env.PORTCOVE_ROADMAP_GH,
  });
  const prefix = `/repos/${repository}`;
  let requests = 0;
  const sdk = await createGitHubClient({
    credential,
    deadline,
    maxBytes: 2 * 1024 * 1024,
    headers: { accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    allowRequest: (method, url) =>
      method === "GET" &&
      url.pathname.startsWith(`${prefix}/actions/`) &&
      !url.pathname.endsWith("/zip"),
    reserve() {
      if (++requests > 8)
        throw new MaintenanceStoreError("Release-content lookup exceeded its request budget");
      return { consumeBytes() {}, settle() {} };
    },
  });
  const get = async (endpoint: string) =>
    (await sdk.request({ method: "GET", url: `https://api.github.com${prefix}/${endpoint}` }))
      .data as Record<string, unknown>;
  const runs = (
    await get(
      "actions/workflows/release-content-scan.yml/runs?event=schedule&branch=main&status=success&per_page=5",
    )
  ).workflow_runs as {
    id: number;
    run_attempt: number;
    head_sha: string;
    head_branch: string;
    event: string;
  }[];
  // A dispatched run never counts, so it can never stand in as a receipt.
  const run = runs.find(
    (candidate) => candidate.head_branch === "main" && candidate.event === "schedule",
  );
  if (!run)
    throw new MaintenanceStoreError("No successful scheduled main release-content scan was found");
  const artifacts = (await get(`actions/runs/${run.id}/artifacts?per_page=10`)).artifacts as {
    id: number;
    name: string;
    expired: boolean;
    size_in_bytes: number;
    digest?: string;
  }[];
  const artifact = artifacts.find(
    (candidate) =>
      candidate.name === `release-content-scan-${run.id}-${run.run_attempt}` && !candidate.expired,
  );
  if (!artifact?.digest?.startsWith("sha256:") || artifact.size_in_bytes > reportLimit)
    throw new MaintenanceStoreError(
      "The release-content report artifact is unavailable or unbound",
    );
  const archive = await downloadGitHubArtifactArchive(
    `repos/${repository}/actions/artifacts/${artifact.id}/zip`,
    {
      credential,
      deadline: performance.now() + 110_000,
      maxBytes: Math.max(22, artifact.size_in_bytes),
    },
  );
  const digest = createHash("sha256").update(archive).digest("hex");
  if (`sha256:${digest}` !== artifact.digest)
    throw new MaintenanceStoreError(
      "The release-content artifact does not match its recorded digest",
    );
  return {
    revision: `release-content-scan-run:${run.id}-${run.run_attempt}@${run.head_sha}#sha256:${digest}`,
    report: zipJsonEntry(archive, "report.json"),
  };
}

const storedFindings = (value: unknown) => {
  const list = (value as { findings?: unknown } | null | undefined)?.findings;
  return Array.isArray(list) ? (list as ContentFinding[]) : [];
};

/**
 * The flagged packages the report shows for a port: its stored facts, and the
 * findings the latest scan that did not fail carried on the port's deferral
 * gap, so a finding is visible before every target of its port is scanned.
 */
export function releaseContentFindings(payload: unknown, gap?: unknown): ContentFinding[] {
  const seen = new Set<string>();
  return [...storedFindings(payload), ...storedFindings(gap)].filter((entry) => {
    const key = `${entry.platform}\t${entry.asset}\t${entry.sha256}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Not-scannable codes that are only coverage notes: the listing's channel has
 * no release, or its hints select no single asset, so there is no package.
 */
export const benignUnscannable: readonly string[] = ["no-release", "no-single-asset"];

export interface UnscannableTarget {
  platform: string;
  code: string;
  /** False for a coverage note; true when a package exists that nobody has inspected. */
  attention: boolean;
}

/**
 * A port's persistent not-scanned targets, from its stored facts and from the
 * latest scan's deferral gap. Every one is shown; all but the coverage notes
 * need attention, because a package exists that the scan could not inspect
 * (`digest-mismatch` may also mean the bytes were altered).
 */
export function releaseContentUnscannable(payload: unknown, gap?: unknown): UnscannableTarget[] {
  const listed = (value: unknown) => {
    const list = (value as { unscannable?: unknown } | null | undefined)?.unscannable;
    return Array.isArray(list) ? (list as { platform: string; code: string }[]) : [];
  };
  const seen = new Set<string>();
  return [...listed(payload), ...listed(gap)].flatMap(({ platform, code }) => {
    const key = `${platform}\t${code}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ platform, code, attention: !benignUnscannable.includes(code) }];
  });
}

/** A finding's signals in words, with "N more" when the scan's cap cut them. */
export function signalSummary(entry: Pick<ContentFinding, "signals" | "signal_count">) {
  // Facts stored before the cap carry no count; every signal is then listed.
  const total = entry.signal_count ?? entry.signals.length;
  return `${entry.signals.map(({ path, reason }) => `${path}: ${reason}`).join("; ")}${
    total > entry.signals.length ? `; and ${total - entry.signals.length} more` : ""
  }`;
}

/**
 * "Needs attention" text for each flagged package that no reviewed accounting
 * dismisses, and each package the scan could not inspect.
 */
export function releaseContentAttention(payload: unknown, gap?: unknown) {
  return [
    ...releaseContentFindings(payload, gap)
      .filter((entry) => !entry.accounted)
      .map(
        (entry) =>
          `release content: ${entry.platform} ${entry.tag} ${entry.asset} (${signalSummary(entry)})`,
      ),
    ...releaseContentUnscannable(payload, gap)
      .filter(({ attention }) => attention)
      .map(({ platform, code }) => `release content not scannable: ${platform} ${code}`),
  ];
}

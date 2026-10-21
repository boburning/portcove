/** Data-only initial-proof amendment contract. Parsing never grants a waiver. */
import { createHash } from "node:crypto";
import { isRecord } from "./runtime-values.mts";

export const initialProofRisk706 = "initial-public-proof-three-total-v1";
export const risk706Expiry = "2026-11-15T04:59:00.000Z";
export const originalRisk706Comment = 6182222682;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function exact(raw: unknown, keys: string): asserts raw is Record<string, unknown> {
  if (!isRecord(raw) || Object.keys(raw).sort().join(",") !== keys)
    throw new Error("initial-proof #706 amendment schema differs");
}
function sha(raw: unknown) {
  if (typeof raw !== "string" || !/^[a-f0-9]{64}$/u.test(raw))
    throw new Error("#706 amendment pin missing");
  return raw;
}
export function inspectInitialProofRisk706(raw: unknown) {
  exact(
    raw,
    "amendment,approved_at,dependency_graph_sha256,expires_at,max_publications,native_inputs_sha256,policy_sha256,profile,schema_version",
  );
  exact(raw.amendment, "body_sha256,comment_id,owner_id");
  if (
    raw.schema_version !== 1 ||
    raw.profile !== initialProofRisk706 ||
    raw.max_publications !== 3 ||
    raw.expires_at !== risk706Expiry ||
    typeof raw.approved_at !== "string" ||
    !Number.isFinite(Date.parse(raw.approved_at)) ||
    Date.parse(raw.approved_at) >= Date.parse(risk706Expiry) ||
    Date.parse(raw.approved_at) <= Date.parse("2026-10-15T01:21:44.000Z") ||
    typeof raw.amendment.comment_id !== "number" ||
    !Number.isSafeInteger(raw.amendment.comment_id) ||
    raw.amendment.comment_id <= originalRisk706Comment ||
    typeof raw.amendment.owner_id !== "number" ||
    !Number.isSafeInteger(raw.amendment.owner_id) ||
    raw.amendment.owner_id < 1
  )
    throw new Error("new owner amendment required; original #706 scope remains one publication");
  return {
    schema_version: 1 as const,
    profile: initialProofRisk706,
    max_publications: 3 as const,
    expires_at: risk706Expiry,
    approved_at: raw.approved_at,
    native_inputs_sha256: sha(raw.native_inputs_sha256),
    dependency_graph_sha256: sha(raw.dependency_graph_sha256),
    policy_sha256: sha(raw.policy_sha256),
    amendment: {
      comment_id: raw.amendment.comment_id,
      owner_id: raw.amendment.owner_id,
      body_sha256: sha(raw.amendment.body_sha256),
    },
  };
}
export type InitialProofRisk706 = ReturnType<typeof inspectInitialProofRisk706>;

/** Exact prepared owner-comment body; its hash is then pinned in the already
 * ratified authority configuration. It cannot select that configuration. */
export function initialProofRisk706Body(raw: unknown) {
  const profile = inspectInitialProofRisk706(raw);
  return JSON.stringify({
    schema_version: 1,
    decision: "approve-initial-public-proof-risk-706",
    owner: "boburning",
    advisory: "RUSTSEC-2024-0429",
    alias: "GHSA-wrw7-89jp-8q8g",
    package: "glib",
    version: "0.18.5",
    profile: profile.profile,
    max_publications: 3,
    count: "total-irreversible-linux-public-exposures",
    approved_at: profile.approved_at,
    expires_at: profile.expires_at,
    native_inputs_sha256: profile.native_inputs_sha256,
    dependency_graph_sha256: profile.dependency_graph_sha256,
    policy_sha256: profile.policy_sha256,
    scanner: "retain-raw-FAIL; exact-attested-producing-job-source-lock-graph; no-scanner-waiver",
  });
}
export function inspectInitialProofRisk706Comment(profileRaw: unknown, raw: unknown, now: string) {
  const profile = inspectInitialProofRisk706(profileRaw);
  if (
    !isRecord(raw) ||
    raw.id !== profile.amendment.comment_id ||
    raw.html_url !==
      `https://github.com/boburning/portcove/issues/706#issuecomment-${profile.amendment.comment_id}` ||
    raw.issue_url !== "https://api.github.com/repos/boburning/portcove/issues/706" ||
    !isRecord(raw.user) ||
    raw.user.id !== profile.amendment.owner_id ||
    raw.user.login !== "boburning" ||
    raw.user.type !== "User" ||
    raw.created_at !== profile.approved_at ||
    typeof raw.body !== "string" ||
    Buffer.byteLength(raw.body) > 16 * 1024 ||
    raw.body !== initialProofRisk706Body(profile) ||
    digest(raw.body) !== profile.amendment.body_sha256 ||
    !Number.isFinite(Date.parse(now)) ||
    Date.parse(now) < Date.parse(profile.approved_at) ||
    Date.parse(now) >= Date.parse(profile.expires_at)
  )
    throw new Error("authenticated new owner #706 amendment is absent, changed or expired");
  return { authority: "none" as const, amendment_sha256: profile.amendment.body_sha256 };
}

/** Workspace versions are supplied only by the independently verified four-file
 * preparation transform. External versions/features remain exact graph input. */
export function risk706GraphDigest(raw: unknown) {
  if (!Array.isArray(raw) || !raw.length || raw.length > 2048)
    throw new Error("complete risk dependency graph required");
  const normalized = raw
    .map((node: unknown) => {
      exact(node, "features,id");
      if (
        typeof node.id !== "string" ||
        !node.id ||
        !Array.isArray(node.features) ||
        !node.features.every((feature: unknown) => typeof feature === "string")
      )
        throw new Error("risk graph node differs");
      return {
        id: node.id.replace(/^([A-Za-z0-9_-]+)@[^:]+:workspace$/u, "$1@workspace"),
        features: [...node.features].sort(),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id, "en"));
  if (new Set(normalized.map((node) => node.id)).size !== normalized.length)
    throw new Error("risk graph identity ambiguous");
  return digest(JSON.stringify(normalized));
}

export interface Risk706Exposure {
  tag: string;
  release_id: number;
}

/** Pin association only, consumed inside both actual private caller joins. */
export function inspectRisk706MeasurementPins(
  profileRaw: unknown,
  measurement: unknown,
  nativeSourceDigest: string,
  fixedPolicyDigest: string,
) {
  const profile = inspectInitialProofRisk706(profileRaw);
  if (
    !isRecord(measurement) ||
    !isRecord(measurement.candidate) ||
    !isRecord(measurement.scan) ||
    !isRecord(measurement.assessment) ||
    measurement.candidate.sourceNativeInputsSha256 !== profile.native_inputs_sha256 ||
    nativeSourceDigest !== profile.native_inputs_sha256 ||
    measurement.scan.lockSha256 !== measurement.candidate.lockSha256 ||
    measurement.assessment.policySha256 !== profile.policy_sha256 ||
    fixedPolicyDigest !== profile.policy_sha256 ||
    measurement.scan.configSha256 !== profile.policy_sha256 ||
    measurement.scan.sourceConfigSha256 !== profile.policy_sha256 ||
    measurement.assessment.dependencyGraphSha256 !== profile.dependency_graph_sha256 ||
    risk706GraphDigest(measurement.candidate.native) !== profile.dependency_graph_sha256
  )
    throw new Error("amended native source/lock/dependency graph/policy differs");
  return { authority: "none" as const };
}
/** Already authenticated readers supply these observations. This pure decision
 * carries no provider, journal, signing or publication authority. */
export function assessInitialProofBudget706(raw: {
  durable: readonly Risk706Exposure[];
  current: readonly Risk706Exposure[];
  pending: boolean;
  publication_tag: string;
}) {
  if (raw.pending) throw new Error("pending/ambiguous public effect requires existing recovery");
  const tags = new Map<string, number>(),
    ids = new Map<number, string>();
  for (const entry of [...raw.durable, ...raw.current]) {
    if (
      !/^v[0-9]+\.[0-9]+\.[0-9]+-(?:alpha|beta)\.[0-9]+$/u.test(entry.tag) ||
      !Number.isSafeInteger(entry.release_id) ||
      entry.release_id < 1 ||
      (tags.has(entry.tag) && tags.get(entry.tag) !== entry.release_id) ||
      (ids.has(entry.release_id) && ids.get(entry.release_id) !== entry.tag)
    )
      throw new Error("public exposure identity is ambiguous or outside the initial proof");
    tags.set(entry.tag, entry.release_id);
    ids.set(entry.release_id, entry.tag);
  }
  if (
    !/^v[0-9]+\.[0-9]+\.[0-9]+-(?:alpha|beta)\.[0-9]+$/u.test(raw.publication_tag) ||
    tags.size > 3 ||
    (!tags.has(raw.publication_tag) && tags.size >= 3)
  )
    throw new Error("#706 initial proof refuses a fourth total public exposure");
  return {
    authority: "none" as const,
    charged_tags: [...tags.keys()].sort(),
    next_tag: raw.publication_tag,
  };
}

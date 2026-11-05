/** Fixed application policy for native GitHub Actions release jobs.
 * GitHub owns execution order and release state; this module grants no authority.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isRecord } from "./runtime-values.mts";

export const applicationReleaseWorkflow = ".github/workflows/application-release.yml";
export const applicationReleaseConcurrency = "application-update-production-controller";
export const applicationReleaseJobMinutes = Object.freeze({
  source: 2,
  tools: 10,
  "package / package": 30,
  "package / provenance": 2,
  "protection_payload / execute": 1,
  "payload / execute": 5,
  "context / execute": 2,
  "protection_metadata / execute": 1,
  "releases / execute": 2,
  "preview / execute": 2,
  "stable / execute": 2,
  draft_recovery: 2,
  "protection_snapshot / execute": 1,
  "snapshot / execute": 2,
  "protection_timestamp / execute": 1,
  "timestamp / execute": 2,
  "assemble / execute": 5,
  "native / execute": 33,
  "native / attest": 2,
  "protection_publication / execute": 1,
  publication: 5,
  publication_prepare: 3,
  "protection_feed / execute": 1,
  feed_prepare: 3,
  feed: 2,
  public_installed: 15,
  readback: 5,
});

/** Mutually exclusive execution paths, never an extra resource allowance.
 * Bootstrap retains its original combined five-minute publisher; an ordinary
 * release splits those same five minutes into preparation3/publication2. */
export function applicationReleaseBudgetMinutes(purpose: unknown) {
  assert.ok(
    purpose === "application-release" ||
      purpose === "metadata-bootstrap" ||
      purpose === "metadata-renewal",
  );
  const jobs: Record<string, number> = { ...applicationReleaseJobMinutes };
  if (purpose === "application-release") {
    jobs.publication = 2;
    jobs.readback = 3;
    jobs.public_installed_readback = 2;
    jobs["protection_draft_recovery / execute"] = 1;
  } else delete jobs.publication_prepare;
  if (purpose === "metadata-bootstrap") {
    delete jobs.draft_recovery;
    jobs["targets / execute"] = 2;
  }
  return Object.freeze(jobs);
}

/** Recovery reuses an immutable payload. Only its actual remaining jobs are
 * reserved; all earlier ordinary work is still charged by the budget reader. */
export function applicationReleaseRemainingMinutes(
  purpose: unknown,
  executionPath: unknown = "ordinary",
) {
  const ordinary = applicationReleaseBudgetMinutes(purpose);
  assert.ok(
    executionPath === "ordinary" ||
      executionPath === "immutable-recovery" ||
      executionPath === "metadata-recovery" ||
      executionPath === "metadata-maintenance",
  );
  if (executionPath === "ordinary") return ordinary;
  if (executionPath === "metadata-maintenance") {
    assert.equal(purpose, "metadata-renewal");
    const payloadWork = new Set([
      "package / package",
      "package / provenance",
      "native / execute",
      "native / attest",
      "protection_payload / execute",
      "payload / execute",
    ]);
    return Object.freeze(
      Object.fromEntries(Object.entries(ordinary).filter(([name]) => !payloadWork.has(name))),
    );
  }
  assert.equal(
    purpose,
    executionPath === "metadata-recovery" ? "metadata-renewal" : "application-release",
  );
  const names = new Set([
    "source",
    "tools",
    "feed_prepare",
    "protection_feed / execute",
    "feed",
    "readback",
    "public_installed",
    "public_installed_readback",
  ]);
  return Object.freeze(
    Object.fromEntries(Object.entries(ordinary).filter(([name]) => names.has(name))),
  );
}

export const applicationReleaseTrust = Object.freeze({
  root: {
    path: "release/bootstrap-public-inputs/application/root.json",
    sha256: "17de1676cd26c4bd2867d3a7941793147b94670d027e7846557d813bc9f43f92",
  },
  targets: {
    path: "release/bootstrap-public-inputs/application/offline-targets.json",
    sha256: "377ca58a2535229056afe552ca34035c3c0791fe4b8ac1a3a0b861dfc2782642",
  },
  payload: {
    path: "release/bootstrap-public-inputs/application/payload-key-registry.json",
    sha256: "3e7738e2e1a87484fa07dcca36c3a35c07f9a53473f65a21d59bbcc3d40ffa10",
  },
  metadata: "https://boburning.github.io/portcove/application/metadata/",
  content: "https://boburning.github.io/portcove/application/targets/",
});

/** Control identity is distinct from the product source built on a fresh runner. */
export function inspectApplicationReleaseExecution(environment: NodeJS.ProcessEnv) {
  const source = environment.PORTCOVE_APPLICATION_RELEASE_REVISION ?? "";
  const ref = environment.PORTCOVE_APPLICATION_RELEASE_REF ?? "";
  const run = environment.GITHUB_RUN_ID ?? "";
  const attempt = Number(environment.GITHUB_RUN_ATTEMPT);
  assert.match(source, /^[a-f0-9]{40}$/u);
  assert.match(ref, /^refs\/tags\/portcove-production-controller-windows-[A-Za-z0-9._-]{1,64}$/u);
  assert.equal(environment.GITHUB_REPOSITORY, "boburning/portcove");
  assert.equal(environment.GITHUB_REPOSITORY_ID, "1354613114");
  assert.equal(environment.GITHUB_EVENT_NAME, "workflow_dispatch");
  assert.equal(environment.GITHUB_REF, ref);
  assert.equal(environment.GITHUB_REF_PROTECTED, "true");
  assert.equal(environment.GITHUB_SHA, source);
  assert.equal(environment.GITHUB_WORKFLOW_SHA, source);
  assert.equal(
    environment.GITHUB_WORKFLOW_REF,
    `boburning/portcove/${applicationReleaseWorkflow}@${ref}`,
  );
  assert.match(run, /^[1-9][0-9]{0,15}$/u);
  assert.ok(Number.isSafeInteger(Number(run)));
  assert.ok(Number.isSafeInteger(attempt) && attempt >= 1 && attempt <= 3);
  return { source, ref, run_id: run, run_attempt: attempt };
}

export async function verifyApplicationReleaseTrust() {
  for (const file of [
    applicationReleaseTrust.root,
    applicationReleaseTrust.targets,
    applicationReleaseTrust.payload,
  ]) {
    const bytes = await readFile(new URL(`../${file.path}`, import.meta.url));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256, file.path);
  }
  return applicationReleaseTrust;
}

/** Secret-free main qualification may build and attest public packages. Its
 * caller identity is never admitted by the private release execution guard. */
export function inspectApplicationPackageExecution(environment: NodeJS.ProcessEnv) {
  if (environment.PORTCOVE_APPLICATION_PACKAGE_MODE !== "qualification")
    return inspectApplicationReleaseExecution(environment);
  assert.equal(environment.GITHUB_REPOSITORY, "boburning/portcove");
  assert.equal(environment.GITHUB_REPOSITORY_ID, "1354613114");
  assert.equal(environment.GITHUB_EVENT_NAME, "workflow_dispatch");
  assert.equal(environment.GITHUB_REF, "refs/heads/main");
  assert.equal(
    environment.GITHUB_WORKFLOW_REF,
    "boburning/portcove/.github/workflows/application-release.yml@refs/heads/main",
  );
  const source = environment.GITHUB_SHA ?? "";
  assert.match(source, /^[a-f0-9]{40}$/u);
  assert.equal(environment.GITHUB_WORKFLOW_SHA, source);
  const run = environment.GITHUB_RUN_ID ?? "";
  assert.match(run, /^[1-9][0-9]{0,15}$/u);
  assert.ok(Number.isSafeInteger(Number(run)));
  const attempt = Number(environment.GITHUB_RUN_ATTEMPT);
  assert.ok(Number.isSafeInteger(attempt) && attempt >= 1 && attempt <= 3);
  return { source, ref: "refs/heads/main", run_id: run, run_attempt: attempt };
}

/** Raw observation only. A paused control can never authorize a signing/feed job. */
export function inspectApplicationPublicationPause(raw: unknown) {
  assert.ok(isRecord(raw) && Object.keys(raw).length === 2);
  assert.equal(raw.schema_version, 1);
  assert.equal(typeof raw.publication_paused, "boolean");
  return { paused: raw.publication_paused, authority: "none" as const };
}

export function inspectApplicationSpendingAppointment(environment: NodeJS.ProcessEnv) {
  const raw: unknown = JSON.parse(environment.PORTCOVE_APPLICATION_RELEASE_SPENDING ?? "null");
  assert.ok(isRecord(raw));
  assert.equal(raw.budget_id, "4a6859d9-fdb7-4da2-afd3-acbdc9848eec");
  assert.equal(raw.scope, "account");
  assert.equal(raw.amount_usd, 0);
  assert.equal(raw.stop_usage, true);
  assert.equal(raw.operator_id, 43177418);
  assert.equal(raw.application_minutes, 140);
  assert.equal(raw.catalog_minutes, 40);
  assert.equal(raw.workflow_sha256, environment.PORTCOVE_APPLICATION_RELEASE_WORKFLOW_SHA256);
  assert.ok(typeof raw.workflow_sha256 === "string" && /^[a-f0-9]{64}$/u.test(raw.workflow_sha256));
  return {
    budget_id: raw.budget_id,
    headroom: "unknown",
    reservation: false,
    paid_fallback: false,
  };
}

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export const canaryIdentity = Object.freeze({
  repository: "boburning/portcove",
  tag: "portcove-controller-canary-20261010",
  workflow: ".github/workflows/application-update-controller-canary.yml",
  environment: "portcove-controller-canary",
  actorIds: Object.freeze(["43177418", "41898282"]),
});

function refuse(message) {
  throw new Error(`controller canary refused: ${message}`);
}

/** Source admission only. GitHub must independently enforce environment reachability. */
export function admitCanary(environment) {
  const ref = `refs/tags/${canaryIdentity.tag}`;
  if (environment.GITHUB_REPOSITORY !== canaryIdentity.repository) refuse("repository");
  if (environment.GITHUB_EVENT_NAME !== "workflow_dispatch") refuse("event");
  if (environment.GITHUB_REF !== ref) refuse("exact controller tag required");
  if (
    environment.GITHUB_WORKFLOW_REF !==
    `${canaryIdentity.repository}/${canaryIdentity.workflow}@${ref}`
  )
    refuse("workflow execution identity");
  if (!/^[a-f0-9]{40}$/u.test(environment.GITHUB_SHA ?? "")) refuse("controller revision");
  if (!canaryIdentity.actorIds.includes(environment.GITHUB_ACTOR_ID))
    refuse("explicit dispatch actor inventory");
  if (!/^[1-9][0-9]{0,15}$/u.test(environment.GITHUB_RUN_ID ?? "")) refuse("run ID");
  if (environment.GITHUB_RUN_ATTEMPT !== "1") refuse("distinct attempt1 required");
  const raw = environment.CANARY_REQUEST ?? "";
  if (Buffer.byteLength(raw, "utf8") > 2048) refuse("request exceeds 2048 bytes");
  let request;
  try {
    request = JSON.parse(raw);
  } catch {
    refuse("request JSON");
  }
  if (
    request === null ||
    Array.isArray(request) ||
    typeof request !== "object" ||
    Object.keys(request).sort().join(",") !== "nonce,operation,schema_version" ||
    request.schema_version !== 1 ||
    request.operation !== "probe-only" ||
    typeof request.nonce !== "string" ||
    !/^[a-f0-9]{32}$/u.test(request.nonce ?? "")
  )
    refuse("inert probe-only request");
  return {
    schema_version: 1,
    kind: "disposable-controller-canary",
    repository: canaryIdentity.repository,
    execution_ref: ref,
    controller_sha: environment.GITHUB_SHA,
    workflow_ref: environment.GITHUB_WORKFLOW_REF,
    actor_id: environment.GITHUB_ACTOR_ID,
    run_id: environment.GITHUB_RUN_ID,
    run_attempt: 1,
    nonce: request.nonce,
    qualification: "source admission only; platform enforcement unproven",
  };
}

/** Reads only disposable canary material; never signing keys or candidate artifacts. */
export function proveCanary(environment) {
  const admission = admitCanary(environment);
  const controller = environment.CANARY_EXPECTED_CONTROLLER_SHA;
  if (!/^[a-f0-9]{40}$/u.test(controller ?? "") || admission.controller_sha !== controller)
    refuse("environment-reviewed controller revision");
  const expected = environment.CANARY_EXPECTED_SHA256;
  const canary = environment.PORTCOVE_CONTROLLER_CANARY;
  if (!/^[a-f0-9]{64}$/u.test(expected ?? "")) refuse("expected disposable canary digest");
  if (!/^[a-f0-9]{64}$/u.test(canary ?? "")) refuse("32-byte disposable canary required");
  const observed = createHash("sha256").update(canary, "utf8").digest("hex");
  if (observed !== expected) refuse("disposable canary identity");
  return {
    ...admission,
    canary_sha256: observed,
    canary_available: true,
    qualification: "canary reachability only; no signing or publication qualification",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const mode = process.argv[2];
    if (process.argv.length !== 3 || !["admit", "prove"].includes(mode))
      refuse("requires admit or prove");
    console.log(
      JSON.stringify(mode === "admit" ? admitCanary(process.env) : proveCanary(process.env)),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

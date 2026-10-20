import { open, readFile } from "node:fs/promises";
import path from "node:path";
import { capacityDigest } from "./release-capacity.mts";
import { isRecord } from "./runtime-values.mts";
import {
  verifyDirectSemanticCapture,
  requireDirectSemanticDispositionCapture,
} from "./release-semantic-runtime.mts";
import {
  readIndependentSemanticDisposition,
  readIndependentSemanticCheckInventory,
} from "./release-semantic-disposition-reader.mts";
import type { runSemanticRuntime } from "./release-semantic-runtime.mts";
import type { CoordinatorRemoteApi } from "./release-coordinator-remote.mts";
import { readIndependentSemanticReview } from "./release-control-inputs.mts";

type Capture = Awaited<ReturnType<typeof runSemanticRuntime>>;
export interface SemanticIssuer {
  app_id: number;
  installation_id: number;
  writer_app_id: number;
}
const repo = "repos/boburning/portcove";
function issuerConfiguration(config: SemanticIssuer) {
  if (
    ![config.app_id, config.installation_id, config.writer_app_id].every(
      (id) => Number.isSafeInteger(id) && id > 0,
    ) ||
    config.app_id === 15368 ||
    config.app_id === config.writer_app_id
  )
    throw new Error("independent issuer identities are unconfigured or conflated");
  return structuredClone(config);
}
async function verifyCapture(capture: Capture) {
  const expected = await verifyDirectSemanticCapture(capture);
  const persisted = await readFile(
    path.join(expected.root, "capture/accepted-handoff.json"),
    "utf8",
  );
  if (persisted !== JSON.stringify(expected.handoff))
    throw new Error("captured report identity changed");
  return expected;
}
function requireIssuer(
  api: CoordinatorRemoteApi,
  appApi: CoordinatorRemoteApi,
  config: SemanticIssuer,
) {
  const get = (client: CoordinatorRemoteApi, route: string) => {
    const response = client.request("GET", route);
    if (response.status !== 200) throw new Error("producer issuer readback unavailable");
    return response.body;
  };
  const app = get(appApi, "app");
  const installation = get(appApi, `app/installations/${config.installation_id}`);
  const repositories = get(api, "installation/repositories?per_page=100");
  if (
    !isRecord(app) ||
    app.id !== config.app_id ||
    !isRecord(installation) ||
    installation.id !== config.installation_id ||
    installation.app_id !== config.app_id ||
    !isRecord(installation.account) ||
    installation.account.id !== 43177418 ||
    installation.account.login !== "boburning" ||
    installation.suspended_at !== null ||
    installation.repository_selection !== "selected" ||
    !isRecord(installation.permissions) ||
    Object.keys(installation.permissions).sort().join(",") !== "checks,metadata" ||
    installation.permissions.checks !== "write" ||
    installation.permissions.metadata !== "read" ||
    !isRecord(repositories) ||
    repositories.total_count !== 1 ||
    !Array.isArray(repositories.repositories) ||
    repositories.repositories.length !== 1 ||
    !isRecord(repositories.repositories[0]) ||
    repositories.repositories[0].id !== 1354613114 ||
    repositories.repositories[0].full_name !== "boburning/portcove"
  )
    throw new Error("producer App/installation/repository/permission boundary differs");
}

/** No CLI/default credential lookup. The fixed provisioned caller must supply
 * an exact grant/custody guard and separated App/installation clients. Mere
 * token availability is not authority. Capture provenance cannot be imported.
 */
export async function publishSemanticCapture(
  capture: Capture,
  rawIssuer: SemanticIssuer,
  options: {
    requireProvisioningGrant: () => Promise<void>;
    authenticateIssuer: () => Promise<{
      app: CoordinatorRemoteApi;
      installation: CoordinatorRemoteApi;
    }>;
  },
) {
  const config = issuerConfiguration(rawIssuer);
  const frozen = await verifyCapture(capture);
  const request = frozen.handoff.proposed_request;
  if (
    request.endpoint !== `${repo}/check-runs` ||
    request.body.name !== "Portcove independent release semantic review" ||
    request.body.head_sha !== frozen.handoff.evidence.opportunity.source_commit
  )
    throw new Error("fixed semantic broker destination/input differs");
  // An exclusive audit receipt prevents a second POST from this invocation.
  // It is not a new candidate/coordinator authority or permission journal.
  const receipt = await open(path.join(frozen.root, "capture/check-attempt.jsonl"), "wx");
  const record = async (phase: string, evidence: unknown = null) => {
    await receipt.write(
      JSON.stringify({
        schema_version: 1,
        invocation: frozen.invocation,
        request_sha256: capacityDigest(request),
        phase,
        evidence,
      }) + "\n",
    );
    await receipt.sync();
  };
  let posted = false;
  try {
    await record("pending-no-post", { issuer: config, request });
    await options.requireProvisioningGrant();
    await verifyCapture(capture);
    // Only after actual runtime acceptance, empty process tree and grant.
    const clients = await options.authenticateIssuer();
    requireIssuer(clients.installation, clients.app, config);
    await verifyCapture(capture);
    await record("post-intent");
    posted = true;
    const response = clients.installation.request("POST", request.endpoint, request.body);
    await record("post-response-observed", {
      status: response.status ?? null,
      response_sha256: capacityDigest(response.body),
    });
    if (
      response.status !== 201 ||
      !isRecord(response.body) ||
      !Number.isSafeInteger(response.body.id)
    )
      throw new Error("CheckRun POST outcome requires provider readback");
    const id = Number(response.body.id);
    const proof = readIndependentSemanticReview(
      clients.installation,
      {
        schema_version: 1,
        review_app_id: config.app_id,
        writer_app_id: config.writer_app_id,
        review_check_name: request.body.name,
      },
      frozen.handoff.evidence.opportunity,
      id,
    );
    const verified: unknown = JSON.parse(proof);
    if (
      !isRecord(verified) ||
      capacityDigest(verified.report) !==
        capacityDigest(JSON.parse(request.body.output.summary) as unknown)
    )
      throw new Error("provider semantic report differs from direct capture");
    await record("verified-provider-result", { check_id: id, proof_sha256: capacityDigest(proof) });
    return {
      authority: "none",
      check_id: id,
      proof,
      qualification:
        "observed producer check binding only; no classification persistence, reservation or execution grant",
    };
  } catch (error) {
    await record(posted ? "ambiguous-requires-readback-no-retry" : "refused-no-post");
    throw error;
  } finally {
    await receipt.close();
  }
}

/** Recovery is GET-only. Zero/multiple matches remain ambiguous; never POST or
 * infer absence of remote effects from an earlier failed response. Caller must
 * retain this report with the original attempt through existing recovery.
 */
export function readbackSemanticCheck(
  api: CoordinatorRemoteApi,
  rawIssuer: SemanticIssuer,
  opportunity: unknown,
  expected: { head: string; external_id: string; summary: string },
) {
  const config = issuerConfiguration(rawIssuer);
  if (!/^[a-f0-9]{40}$/u.test(expected.head)) throw new Error("readback source identity invalid");
  const producer = {
    schema_version: 1,
    review_app_id: config.app_id,
    writer_app_id: config.writer_app_id,
    review_check_name: "Portcove independent release semantic review",
  };
  const inventory = readIndependentSemanticCheckInventory(api, producer, expected.head);
  const matches = inventory.records.filter((value) => value.external_id === expected.external_id);
  if (
    matches.length !== 1 ||
    !isRecord(matches[0]!.output) ||
    matches[0]!.output.summary !== expected.summary
  )
    throw new Error("semantic POST remains ambiguous; preserve original attempt, no retry");
  const id = Number(matches[0]!.id);
  const proof = readIndependentSemanticReview(api, producer, opportunity, id);
  const verified: unknown = JSON.parse(proof);
  if (
    !isRecord(verified) ||
    capacityDigest(verified.report) !== capacityDigest(JSON.parse(expected.summary) as unknown)
  )
    throw new Error("semantic readback detail differs from original direct capture; no retry");
  inventory.assertUnchanged();
  return { check_id: id, proof };
}

/** Failure-only, directly captured settled producer result. No D1 acceptance. */
export async function publishSemanticDispositionCapture(
  capture: unknown,
  rawIssuer: SemanticIssuer,
  options: Parameters<typeof publishSemanticCapture>[2],
) {
  const config = issuerConfiguration(rawIssuer);
  const frozen = await requireDirectSemanticDispositionCapture(capture);
  const request = frozen.proposed_request;
  const receipt = await open(path.join(frozen.root, "capture/check-attempt.jsonl"), "wx");
  const record = async (phase: string, evidence: unknown = null) => {
    await receipt.write(
      JSON.stringify({
        schema_version: 1,
        invocation: frozen.invocation,
        request_sha256: capacityDigest(request),
        phase,
        evidence,
      }) + "\n",
    );
    await receipt.sync();
  };
  let posted = false;
  try {
    await record("pending-no-post", { issuer: config, request });
    await options.requireProvisioningGrant();
    await requireDirectSemanticDispositionCapture(capture);
    const clients = await options.authenticateIssuer();
    requireIssuer(clients.installation, clients.app, config);
    await requireDirectSemanticDispositionCapture(capture);
    await record("post-intent");
    posted = true;
    const response = clients.installation.request("POST", request.endpoint, request.body);
    await record("post-response-observed", {
      status: response.status ?? null,
      response_sha256: capacityDigest(response.body),
    });
    if (
      response.status !== 201 ||
      !isRecord(response.body) ||
      !Number.isSafeInteger(response.body.id)
    )
      throw new Error("negative Check POST outcome requires readback");
    const proof = readIndependentSemanticDisposition(
      clients.installation,
      {
        schema_version: 1,
        review_app_id: config.app_id,
        writer_app_id: config.writer_app_id,
        review_check_name: request.body.name,
      },
      frozen.wire.request,
      Number(response.body.id),
    );
    if (proof.wire_sha256 !== frozen.wire_sha256)
      throw new Error("provider negative report differs from settled direct capture");
    await record("verified-provider-negative-result", {
      check_id: proof.check_run_id,
      proof_sha256: capacityDigest(proof),
    });
    return proof;
  } catch (error) {
    await record(posted ? "ambiguous-requires-readback-no-retry" : "refused-no-post");
    throw error;
  } finally {
    await receipt.close();
  }
}

/** GET-only reconciliation of a failure Check. An imported receipt is a locator,
 * never a runtime brand or authority to post another Check. */
export function readbackSemanticDispositionCheck(
  api: CoordinatorRemoteApi,
  rawIssuer: SemanticIssuer,
  request: unknown,
  expected: { head: string; external_id: string; summary: string },
) {
  const config = issuerConfiguration(rawIssuer);
  const producer = {
    schema_version: 1,
    review_app_id: config.app_id,
    writer_app_id: config.writer_app_id,
    review_check_name: "Portcove independent release semantic review",
  };
  const inventory = readIndependentSemanticCheckInventory(api, producer, expected.head);
  const matches = inventory.records.filter((value) => value.external_id === expected.external_id);
  if (
    matches.length !== 1 ||
    !isRecord(matches[0]!.output) ||
    matches[0]!.output.summary !== expected.summary
  )
    throw new Error("negative semantic POST remains ambiguous; retain original attempt, no retry");
  const proof = readIndependentSemanticDisposition(api, producer, request, Number(matches[0]!.id));
  if (
    proof.wire_sha256 !== capacityDigest(JSON.parse(expected.summary) as unknown) ||
    proof.summary_sha256 !== capacityDigest(expected.summary)
  )
    throw new Error("negative semantic detail differs from original capture; no retry");
  inventory.assertUnchanged();
  return proof;
}

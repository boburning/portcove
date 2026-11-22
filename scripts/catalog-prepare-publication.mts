import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs, promisify } from "node:util";
import {
  readCatalogCoreMachineEnvelope,
  readCatalogPublicationBundle,
} from "./release-catalog-inspection.mts";
import {
  catalogDefinitionContentBytes,
  catalogPublicationInventory,
} from "./release-catalog-publication-contract.mts";
import { parseCatalogPublicationRequest } from "./release-catalog-source.mts";
import { releaseCanonicalDigest } from "./release-canonical.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { preparePayloadSigningEnvironment } from "./release-payload-signing.mts";
import { isRecord } from "./runtime-values.mts";
import { inspectCatalogDefinitions } from "./observe-configured-upstream.mts";
import { fileIdentity } from "./development-evidence.mts";
import { validateObserverConfig } from "./upstream-observer.mts";
import {
  managedN64OriginalProjection,
  verifyManagedN64OriginalProposal,
} from "./n64-original-publication.mts";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const indexTarget = "definitions/index.json";
const listingTarget = "policy/official/catalog.listings.json";
const run = promisify(execFile);
type Files = ReadonlyMap<string, Buffer>;

function document(bytes: Buffer | undefined) {
  if (!bytes) throw new Error("reviewed publication input is missing");
  const text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes)) throw new Error("publication input is not lossless UTF-8");
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) throw new Error("publication input must be a JSON object");
  return value;
}

/** The caller supplies the reviewed source graph and schema. The only inserted
 * value is the exact selected operational row from the generated catalog. */
export function generatedPublicationProjection(
  catalogBytes: Buffer,
  portId: string,
  templateBytes: Buffer,
) {
  const catalog = document(catalogBytes);
  const template = document(templateBytes);
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/u.test(portId) || !Array.isArray(catalog.ports))
    throw new Error("a generated operational catalog and exact stable ID are required");
  if (
    Object.keys(template).sort().join(",") !== "catalog,contract_schema,representation" ||
    (template.contract_schema !== 1 &&
      template.contract_schema !== 2 &&
      template.contract_schema !== 3) ||
    template.representation !== "catalog_projection" ||
    !isRecord(template.catalog) ||
    !Array.isArray(template.catalog.ports) ||
    template.catalog.ports.length !== 0
  )
    throw new Error("a reviewed catalog projection template with an empty ports array is required");
  const matches = catalog.ports.filter((port) => isRecord(port) && port.id === portId);
  if (matches.length !== 1)
    throw new Error("the generated operational definition is missing or ambiguous");
  if (
    matches.some((port) => isRecord(port) && "mod_loader" in port) &&
    template.contract_schema !== 3
  )
    throw new Error("native mod loaders require catalog projection schema 3");
  template.catalog.ports = matches;
  const bytes = Buffer.from(`${JSON.stringify(template, null, 2)}\n`);
  if (bytes.length > catalogDefinitionContentBytes)
    throw new Error("catalog projection exceeds its bound");
  return bytes;
}

function definitions(files: Files) {
  const index = document(files.get(indexTarget));
  if (!Array.isArray(index.definitions))
    throw new Error("reviewed publication index is missing definitions");
  const rows = new Map<string, { target: string; revision: number }>();
  for (const row of index.definitions as unknown[]) {
    if (
      !isRecord(row) ||
      row.namespace !== "official" ||
      typeof row.stable_id !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,127}$/u.test(row.stable_id) ||
      rows.has(row.stable_id) ||
      typeof row.target !== "string" ||
      !/^sha256\/[a-f0-9]{64}\.json$/u.test(row.target) ||
      typeof row.revision !== "number" ||
      !Number.isSafeInteger(row.revision) ||
      row.revision < 1
    )
      throw new Error("reviewed publication definition identity is invalid");
    rows.set(row.stable_id, { target: row.target, revision: row.revision });
  }
  return rows;
}

function compareRevision(
  prior: Record<string, unknown>,
  next: Record<string, unknown>,
  field: string,
  changed: boolean,
) {
  const before = prior[field];
  const after = next[field];
  if (
    typeof before !== "number" ||
    typeof after !== "number" ||
    !Number.isSafeInteger(before) ||
    !Number.isSafeInteger(after) ||
    before < 1 ||
    after < before ||
    (changed && after === before)
  )
    throw new Error(`reviewed ${field} does not advance retained publication state`);
}

function policySemantics(policy: Record<string, unknown>) {
  const { policy_revision: _revision, decision, ...identity } = policy;
  if (!isRecord(decision)) throw new Error("reviewed publisher decision is missing");
  const { index_sha256: _index, ...scope } = decision;
  return { ...identity, decision: scope };
}

function launchSemantics(launch: Record<string, unknown>) {
  const { revision: _revision, policy_sha256: _policy, ...assessments } = launch;
  return assessments;
}

/** Extends one identified entry using already reviewed index and policy bytes.
 * A changed global index cannot silently reuse an old policy or launch hash. */
export function assembleReviewedPublication(
  prior: Files,
  reviewed: Files,
  portId: string,
  projection: Buffer,
) {
  const prepared = document(projection);
  const sources = isRecord(prepared.catalog) ? prepared.catalog.source_catalog : null;
  if (
    isRecord(sources) &&
    Array.isArray(sources.qualification) &&
    sources.qualification.some(
      (record) => isRecord(record) && Object.hasOwn(record, "successor_support"),
    )
  )
    throw new Error(
      "successor support publication requires the released reader and reviewed evidence producer",
    );
  const before = definitions(prior);
  const after = definitions(reviewed);
  const selected = after.get(portId);
  if (!selected || [...after.keys()].some((id) => id !== portId && !before.has(id)))
    throw new Error("reviewed index does not describe one selected definition");
  const entry = document(reviewed.get(selected.target));
  if (entry.definition_schema !== document(projection).contract_schema)
    throw new Error("reviewed definition and generated projection schemas differ");
  const target = entry.execution_contract;
  if (
    typeof target !== "string" ||
    !/^sha256\/[a-f0-9]{64}\.json$/u.test(target) ||
    entry.persistence_contract !== target ||
    !isDeepStrictEqual(entry.source_contracts, [target])
  )
    throw new Error("reviewed entry must bind one source, execution and persistence projection");
  let contents = projection;
  if (target !== `sha256/${hash(projection)}.json`) {
    // Retain already reviewed exact bytes for semantically identical older JSON
    // serialization. A new leaf must match the generated digest directly.
    const previousProjection = prior.get(target);
    if (
      !previousProjection ||
      target !== `sha256/${hash(previousProjection)}.json` ||
      !isDeepStrictEqual(document(previousProjection), document(projection))
    )
      throw new Error("generated projection digest differs from the reviewed definition entry");
    contents = previousProjection;
  }
  const supplied = reviewed.get(target);
  if (supplied && !supplied.equals(contents))
    throw new Error("reviewed projection bytes differ from generation");

  if (!isDeepStrictEqual(prior.get(listingTarget), reviewed.get(listingTarget)))
    throw new Error("managed definition preparation must preserve descriptive listing bytes");
  const indexHash = hash(reviewed.get(indexTarget)!);
  for (const [id, previous] of before) {
    const replacement = after.get(id);
    if (
      !replacement ||
      (id !== portId && !isDeepStrictEqual(previous, replacement)) ||
      (id === portId &&
        (replacement.revision < previous.revision ||
          (replacement.target !== previous.target && replacement.revision === previous.revision)))
    )
      throw new Error(`reviewed index changes or removes retained definition ${id}`);
    const policyTarget = `policy/official/${id}.json`;
    const launchTarget = `policy/official/${id}.launch.json`;
    const oldPolicy = document(prior.get(policyTarget));
    const policyBytes = reviewed.get(policyTarget);
    if (!policyBytes) throw new Error(`reviewed retained policy is required for ${id}`);
    const nextPolicy = document(policyBytes);
    compareRevision(
      oldPolicy,
      nextPolicy,
      "policy_revision",
      !prior.get(policyTarget)!.equals(policyBytes),
    );
    if (
      id !== portId &&
      !isDeepStrictEqual(policySemantics(oldPolicy), policySemantics(nextPolicy))
    )
      throw new Error(`reviewed publisher grant changes retained scope for ${id}`);
    if (!isRecord(nextPolicy.decision) || nextPolicy.decision.index_sha256 !== indexHash)
      throw new Error(`reviewed policy must bind the new complete index for ${id}`);
    const oldLaunchBytes = prior.get(launchTarget);
    const launchBytes = reviewed.get(launchTarget);
    if (oldLaunchBytes) {
      if (!launchBytes) throw new Error(`reviewed retained launch record is required for ${id}`);
      const oldLaunch = document(oldLaunchBytes);
      const nextLaunch = document(launchBytes);
      compareRevision(oldLaunch, nextLaunch, "revision", !oldLaunchBytes.equals(launchBytes));
      if (
        id !== portId &&
        !isDeepStrictEqual(launchSemantics(oldLaunch), launchSemantics(nextLaunch))
      )
        throw new Error(`reviewed launch assessments change retained scope for ${id}`);
      if (nextLaunch.policy_sha256 !== hash(policyBytes))
        throw new Error(`reviewed launch must bind the new policy for ${id}`);
    } else if (id !== portId && launchBytes)
      throw new Error(`unexpected retained launch record for ${id}`);
  }
  return { files: new Map([...reviewed, [target, contents]]), contents };
}

async function canonicalProjection(validator: string, draft: Buffer, deadline: number) {
  const scratch = await mkdtemp(path.join(tmpdir(), "portcove-definition-projection-"));
  try {
    const input = path.join(scratch, "projection.json");
    await writeFile(input, draft, { flag: "wx", mode: 0o600 });
    const { stdout, stderr } = await run(
      validator,
      ["--json", "catalog", "canonical-definition-projection", input],
      {
        cwd: scratch,
        env: await preparePayloadSigningEnvironment(path.join(scratch, "environment")),
        timeout: Math.max(1, Math.floor(deadline - performance.now())),
        maxBuffer: 2 * catalogDefinitionContentBytes + 4096,
      },
    );
    const result: unknown = JSON.parse(stdout);
    if (
      stderr !== "" ||
      !isRecord(result) ||
      result.ok !== true ||
      result.command !== "catalog.canonical-definition-projection" ||
      typeof result.data !== "string"
    )
      throw new Error("Core did not produce a canonical definition projection");
    const projection = Buffer.from(result.data);
    if (projection.length === 0 || projection.length > catalogDefinitionContentBytes)
      throw new Error("canonical projection exceeds its bound");
    return projection;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function main(argv: string[]) {
  const [command, ...args] = argv;
  const { values } = parseArgs({
    args,
    options: Object.fromEntries(
      [
        "catalog",
        "port",
        "projection-template",
        "projection-producer",
        "prior",
        "reviewed",
        "validator",
        "output-parent",
        "original-input-checkpoint",
        "observer-cli",
        "game-lifecycle-directory",
        "game-lifecycle-expectation",
      ].map((name) => [name, { type: "string" as const }]),
    ),
  });
  const requireString = (key: string) => {
    const value = values[key];
    if (typeof value !== "string" || !value) throw new Error(`--${key} is required`);
    return value;
  };
  if (command === "inspect-game-lifecycle") {
    const directory = path.resolve(requireString("game-lifecycle-directory"));
    const expectation = path.resolve(requireString("game-lifecycle-expectation"));
    const { readBoundedPublicBuildInputFile } = await import("./release-public-build-inputs.mts");
    const { verifyAttestedGameLifecycle } = await import("./game-lifecycle-receipt.mts");
    const document: unknown = JSON.parse(
      (
        await readBoundedPublicBuildInputFile(
          path.dirname(expectation),
          path.basename(expectation),
          8192,
        )
      ).toString("utf8"),
    );
    if (
      !isRecord(document) ||
      typeof document.preparation_sha256 !== "string" ||
      typeof document.executable_sha256 !== "string" ||
      typeof document.check_plan_sha256 !== "string" ||
      typeof document.run_id !== "string" ||
      typeof document.run_attempt !== "number" ||
      typeof document.job_id !== "string" ||
      typeof document.source_commit !== "string"
    )
      throw new Error("Review requires an exact game lifecycle expectation");
    const receipt = await verifyAttestedGameLifecycle(directory, {
      preparation_sha256: document.preparation_sha256,
      executable_sha256: document.executable_sha256,
      check_plan_sha256: document.check_plan_sha256,
      run_id: document.run_id,
      run_attempt: document.run_attempt,
      job_id: document.job_id,
      source_commit: document.source_commit,
      now: Math.floor(Date.now() / 1000),
    });
    process.stdout.write(`${JSON.stringify(receipt)}
`);
    return;
  }
  if (command !== "project" && command !== "prepare")
    throw new Error("expected project, prepare or inspect-game-lifecycle");
  if (
    values["game-lifecycle-directory"] !== undefined ||
    values["game-lifecycle-expectation"] !== undefined
  )
    throw new Error("Game lifecycle verification cannot authorize catalog publication");
  const id = requireString("port");
  const deadline = performance.now() + 90_000;
  const checkpointPath = values["original-input-checkpoint"];
  const fromObserver = typeof checkpointPath === "string";
  if (fromObserver && (values.catalog !== undefined || values["projection-template"] !== undefined))
    throw new Error("Choose canonical catalog preparation or the original-input checkpoint");
  if (!fromObserver && values["observer-cli"] !== undefined)
    throw new Error("--observer-cli requires an original-input checkpoint");
  const priorDirectory =
    command === "prepare" || fromObserver ? path.resolve(requireString("prior")) : undefined;
  const prior = priorDirectory
    ? await readCatalogPublicationBundle(priorDirectory, deadline)
    : undefined;
  let authored:
    | { draft: Buffer; reader: number; checkpointSha256: string; observerCoreSha256: string }
    | undefined;
  let catalog: Buffer | undefined;
  let template: Buffer | undefined;
  if (fromObserver) {
    const observerCore = path.resolve(requireString("observer-cli"));
    const catalogRoot = new URL("../crates/portcove-core/catalog/", import.meta.url);
    const [catalogBytes, listingBytes] = await Promise.all([
      readControllerToolFile(fileURLToPath(new URL("catalog.json", catalogRoot)), 16 * 1024 ** 2),
      readControllerToolFile(fileURLToPath(new URL("listings.json", catalogRoot)), 8 * 1024 ** 2),
    ]);
    const catalogInput = document(catalogBytes);
    const listingInput = document(listingBytes);
    if (!Array.isArray(listingInput.listings))
      throw new Error("Current observer listings are unavailable");
    const bytes = await readControllerToolFile(path.resolve(checkpointPath), 32 * 1024 ** 2);
    const checkpoint: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const observerConfig = validateObserverConfig(
      document(
        await readControllerToolFile(
          fileURLToPath(new URL("../release/upstream-observer.json", import.meta.url)),
          16_384,
        ),
      ),
    );
    const scratch = await mkdtemp(path.join(tmpdir(), "portcove-observer-policy-"));
    try {
      const identity = () =>
        fileIdentity(observerCore, {
          signal: AbortSignal.timeout(
            Math.max(1, Math.min(30_000, Math.floor(deadline - performance.now()))),
          ),
        });
      const before = await identity();
      const definitions = await inspectCatalogDefinitions(observerCore, scratch, catalogBytes, {
        deadline,
        now: () => performance.now(),
      });
      const after = await identity();
      if (!isDeepStrictEqual(before, after))
        throw new Error("Observer Core policy binary changed during preparation");
      authored = {
        ...managedN64OriginalProjection(
          prior!,
          id,
          { ...catalogInput, listings: listingInput.listings as unknown[] },
          checkpoint,
          {
            policyIdentity: before.sha256,
            definitionHash: (portId) => definitions.get(portId) ?? "",
            staleAfterHours: observerConfig.stale_after_hours,
          },
        ),
        checkpointSha256: hash(bytes),
        observerCoreSha256: before.sha256,
      };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  } else {
    catalog = await readControllerToolFile(
      path.resolve(requireString("catalog")),
      catalogDefinitionContentBytes,
    );
    template = await readControllerToolFile(
      path.resolve(requireString("projection-template")),
      catalogDefinitionContentBytes,
    );
  }
  const validator = path.resolve(requireString("validator"));
  const producer =
    typeof values["projection-producer"] === "string"
      ? path.resolve(requireString("projection-producer"))
      : validator;
  const toolFingerprint = async (file: string) =>
    hash(await readControllerToolFile(file, 768 * 1024 ** 2));
  const validatorHash = await toolFingerprint(validator);
  const producerHash = producer === validator ? validatorHash : await toolFingerprint(producer);
  const projection = await canonicalProjection(
    producer,
    authored?.draft ?? generatedPublicationProjection(catalog!, id, template!),
    deadline,
  );
  if ((await toolFingerprint(producer)) !== producerHash)
    throw new Error("Core projection producer changed during preparation");
  if (command === "project") {
    process.stdout.write(projection);
    return;
  }

  const reviewDirectory = path.resolve(requireString("reviewed"));
  const parent = path.resolve(requireString("output-parent"));
  const reviewed = await readCatalogPublicationBundle(
    path.join(reviewDirectory, "bundle"),
    deadline,
  );
  const request = await readControllerToolFile(path.join(reviewDirectory, "request.json"), 16_384);
  parseCatalogPublicationRequest(request);
  const { files, contents } = assembleReviewedPublication(prior!, reviewed, id, projection);
  if (authored) verifyManagedN64OriginalProposal(prior!, files, id, authored.reader);
  const output = await mkdtemp(path.join(parent, "catalog-publication-"));
  const scratch = path.join(output, "inspection");
  let complete = false;
  try {
    const bundle = path.join(output, "bundle");
    for (const [name, bytes] of files) {
      const file = path.join(bundle, name);
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(file, bytes, { flag: "wx", mode: 0o600 });
    }
    const env = await preparePayloadSigningEnvironment(scratch);
    const inspect = async (directory: string, expected: Files) => {
      const { stdout, stderr } = await run(
        validator,
        ["--json", "catalog", "inspect-definition-publication", directory],
        {
          cwd: scratch,
          env,
          timeout: Math.max(1, Math.floor(deadline - performance.now())),
          maxBuffer: 4 * 1024 ** 2,
        },
      );
      readCatalogCoreMachineEnvelope(stdout, stderr, expected);
      const readback = await readCatalogPublicationBundle(directory, deadline);
      if (
        !isDeepStrictEqual(
          catalogPublicationInventory(readback),
          catalogPublicationInventory(expected),
        )
      )
        throw new Error("reviewed publication bytes changed during inspection");
    };
    await inspect(priorDirectory!, prior!);
    await inspect(bundle, files);
    if ((await toolFingerprint(validator)) !== validatorHash)
      throw new Error("Core validator changed during inspection");
    if (producer !== validator && (await toolFingerprint(producer)) !== producerHash)
      throw new Error("Core projection producer changed during inspection");
    await writeFile(path.join(output, "request.json"), request, { flag: "wx", mode: 0o600 });
    await rm(scratch, { recursive: true, force: true });
    complete = true;
    console.log(
      JSON.stringify({
        directory: output,
        ...(authored
          ? {
              original_input_checkpoint_sha256: authored.checkpointSha256,
              observer_core_sha256: authored.observerCoreSha256,
              original_input_draft_sha256: hash(authored.draft),
              required_n64_reader: authored.reader,
            }
          : {
              generated_catalog_sha256: hash(catalog!),
              projection_template_sha256: hash(template!),
            }),
        projection_sha256: hash(contents),
        request_sha256: hash(request),
        index_sha256: hash(files.get(indexTarget)!),
        prior_bundle_sha256: releaseCanonicalDigest(catalogPublicationInventory(prior!)),
        bundle_sha256: releaseCanonicalDigest(catalogPublicationInventory(files)),
        validator_sha256: validatorHash,
        projection_producer_sha256: producerHash,
        authority: "none",
      }),
    );
  } finally {
    if (!complete) await rm(output, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main(process.argv.slice(2));

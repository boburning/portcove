/** Keyless authoring for an existing independently scoped literal launch.
 * The reviewed publication workflow still owns candidate validation and signing. */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { assembleReviewedPublication } from "./catalog-prepare-publication.mts";
import { readCatalogPublicationBundle } from "./release-catalog-inspection.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { isRecord } from "./runtime-values.mts";

type Files = ReadonlyMap<string, Buffer>;
type Doc = Record<string, unknown>;
const indexTarget = "definitions/index.json";
const feature = "runtime.reviewed-package-and-launch-v1";
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const json = (v: unknown) => Buffer.from(`${JSON.stringify(v, null, 2)}\n`);
const target = (b: Buffer) => `sha256/${hash(b)}.json`;

function object(value: unknown): Doc {
  if (!isRecord(value)) throw new Error("expected a catalog publication object");
  return value;
}
function read(files: Files, name: string) {
  const bytes = files.get(name);
  if (!bytes) throw new Error(`missing catalog publication target ${name}`);
  return bytes;
}
function parse(bytes: Buffer) {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes)) throw new Error("invalid catalog publication UTF-8");
  return object(JSON.parse(text) as unknown);
}
function rows(value: unknown): Doc[] {
  if (!Array.isArray(value)) throw new Error("expected catalog publication rows");
  return value.map(object);
}
function nextRevision(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER)
    throw new Error("invalid catalog publication revision");
  return value + 1;
}

function subject(files: Files, id: string) {
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/u.test(id)) throw new Error("invalid stable ID");
  const index = parse(read(files, indexTarget));
  const definitions = rows(index.definitions);
  const found = definitions.filter((row) => row.namespace === "official" && row.stable_id === id);
  if (found.length !== 1) throw new Error("exact existing official definition is required");
  const row = found[0]!;
  const leaf = (key: unknown) => {
    if (typeof key !== "string" || !/^sha256\/[0-9a-f]{64}\.json$/u.test(key))
      throw new Error("invalid definition content address");
    const bytes = read(files, key);
    if (target(bytes) !== key) throw new Error("definition content digest differs");
    return bytes;
  };
  const entry = parse(leaf(row.target));
  if (entry.revision !== row.revision || entry.stable_id !== id ||
      !isDeepStrictEqual(entry.source_contracts, [entry.execution_contract]) ||
      entry.persistence_contract !== entry.execution_contract ||
      !isDeepStrictEqual(entry.artifact_bindings, []) ||
      !isDeepStrictEqual(entry.evidence_references, []))
    throw new Error("expected one unchanged shared definition projection");
  const projection = parse(leaf(entry.execution_contract));
  const catalog = object(projection.catalog);
  const ports = rows(catalog.ports);
  if (ports.length !== 1 || !isDeepStrictEqual(ports[0], entry.port))
    throw new Error("entry and exact projected subject differ");
  return { index, definitions, row, entry, projection, catalog, port: ports[0]! };
}

export function literalLaunchDraft(prior: Files, id: string) {
  const { entry, projection, catalog, port } = subject(prior, id);
  const args = port.launch_arguments;
  const platforms = port.platforms;
  const release = object(port.release);
  if (entry.definition_schema !== 1 || projection.contract_schema !== 1 ||
      port.adapter !== "native-portable" || release.provider !== "github" ||
      Object.keys(object(release.curated ?? {})).length !== 0 ||
      "reviewed_launch_contract_v1" in port || port.managed_initialization !== undefined ||
      !Array.isArray(args) || args.length === 0 || args.length > 64 ||
      args.some((a: unknown) => typeof a !== "string" || !a || a.length > 4096 || /\p{Cc}/u.test(a)) ||
      !Array.isArray(platforms) || platforms.length === 0 ||
      !platforms.every((v: unknown) => typeof v === "string") ||
      new Set(platforms).size !== platforms.length)
    throw new Error("only exact existing literal native GitHub launch arguments can move");
  const launch = Object.fromEntries(platforms.map((platform: string) => [platform, { arguments: args }]));
  return json({ ...projection, contract_schema: 3, catalog: {
    ...catalog, ports: [{ ...port, launch_arguments: [], reviewed_launch_contract_v1: { launch } }],
  } });
}

function nextBindings(prior: Files, next: Map<string, Buffer>, selected: string, entry: Doc) {
  const previousIndex = hash(read(prior, indexTarget));
  const nextIndex = hash(read(next, indexTarget));
  for (const row of rows(parse(read(prior, indexTarget)).definitions)) {
    const id = String(row.stable_id);
    const policyPath = `policy/official/${id}.json`;
    const launchPath = `policy/official/${id}.launch.json`;
    const policyBytes = read(prior, policyPath);
    const policy = parse(policyBytes);
    const decision = object(policy.decision);
    const entrySha = hash(read(prior, String(row.target)));
    const launch = parse(read(prior, launchPath));
    if (policy.namespace !== "official" || policy.stable_id !== id ||
        decision.status !== "managed_github" || decision.index_sha256 !== previousIndex ||
        decision.definition_revision !== row.revision || decision.definition_sha256 !== entrySha ||
        launch.stable_id !== id || launch.policy_sha256 !== hash(policyBytes))
      throw new Error(`independent policy and launch bindings differ for ${id}`);
    const nextPolicy = json({ ...policy, policy_revision: nextRevision(policy.policy_revision),
      decision: { ...decision, index_sha256: nextIndex, ...(id === selected ? {
        definition_revision: entry.revision, definition_sha256: hash(json(entry)),
      } : {}) },
    });
    next.set(policyPath, nextPolicy);
    next.set(launchPath, json({ ...launch, revision: nextRevision(launch.revision),
      policy_sha256: hash(nextPolicy),
    }));
  }
}

export function literalLaunchBundle(prior: Files, id: string, projection: Buffer, legacyFeatures: string[]) {
  const { index, definitions, row, entry } = subject(prior, id);
  if (!isDeepStrictEqual(parse(projection), parse(literalLaunchDraft(prior, id))))
    throw new Error("typed projection changes facts beyond the reviewed literal launch move");
  if (legacyFeatures.includes(feature) || new Set(legacyFeatures).size !== legacyFeatures.length ||
      !legacyFeatures.every((name) => /^[a-z][a-z0-9.-]{0,79}$/u.test(name)))
    throw new Error("invalid reviewed feature names");
  const selectedPort = rows(object(parse(projection).catalog).ports)[0];
  const projectionTarget = target(projection);
  const nextEntry = { ...entry, definition_schema: 4, revision: nextRevision(row.revision),
    port: selectedPort, required_features: [...legacyFeatures, feature],
    source_contracts: [projectionTarget], execution_contract: projectionTarget,
    persistence_contract: projectionTarget,
  };
  return bind(prior, id, index, definitions, row, nextEntry, projection);
}

export function literalLaunchRollback(prior: Files, baseline: Files, id: string) {
  const current = subject(prior, id);
  const original = subject(baseline, id);
  if (!isDeepStrictEqual(current.projection, parse(literalLaunchDraft(baseline, id))) ||
      current.entry.definition_schema !== 4 ||
      !isDeepStrictEqual(current.entry.required_capabilities, original.entry.required_capabilities))
    throw new Error("the current definition is outside the exact reviewed transition");
  const projection = read(baseline, String(original.entry.execution_contract));
  const entry = { ...original.entry, revision: nextRevision(current.row.revision) };
  return bind(prior, id, current.index, current.definitions, current.row, entry, projection);
}

function bind(prior: Files, id: string, index: Doc, definitions: Doc[], row: Doc, entry: Doc, projection: Buffer) {
  const entryBytes = json(entry);
  const entryTarget = target(entryBytes);
  const projectionTarget = target(projection);
  const next = new Map(prior);
  const remaining = definitions.filter((definition) => definition !== row);
  const oldProjection = parse(read(prior, String(row.target))).execution_contract;
  const survivingReferences = new Set(remaining.flatMap((definition) => {
    const unchanged = parse(read(prior, String(definition.target)));
    return [definition.target, unchanged.execution_contract, unchanged.persistence_contract,
      ...[unchanged.source_contracts, unchanged.artifact_bindings, unchanged.evidence_references]
        .flatMap((value) => Array.isArray(value) ? value : [])];
  }));
  const retired = [row.target, oldProjection].filter((name) =>
    name !== entryTarget && name !== projectionTarget && !survivingReferences.has(name));
  const contents = rows(index.contents).filter((content) => !retired.includes(content.target));
  for (const name of retired) next.delete(String(name));
  for (const bytes of [entryBytes, projection]) {
    const name = target(bytes);
    if (!contents.some((r) => r.target === name))
      contents.push({ target: name, sha256: hash(bytes), length: bytes.length });
    next.set(name, bytes);
  }
  next.set(indexTarget, json({ ...index, definitions: definitions.map((d) =>
    d === row ? { ...row, target: entryTarget, revision: entry.revision } : d),
    contents: contents.sort((a, b) => String(a.target).localeCompare(String(b.target))),
  }));
  nextBindings(prior, next, id, entry);
  return assembleReviewedPublication(prior, next, id, projection).files;
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  const { values } = parseArgs({ args, options: {
    prior: { type: "string" }, port: { type: "string" }, baseline: { type: "string" },
    projection: { type: "string" }, feature: { type: "string", multiple: true },
    "output-parent": { type: "string" },
  } });
  if (!values.prior || !values.port) throw new Error("--prior and --port are required");
  const deadline = performance.now() + 90000;
  const prior = await readCatalogPublicationBundle(path.resolve(values.prior), deadline);
  if (mode === "draft") {
    process.stdout.write(literalLaunchDraft(prior, values.port));
    return;
  }
  if (!values["output-parent"]) throw new Error("--output-parent is required");
  const files = mode === "bind" && values.projection
    ? literalLaunchBundle(prior, values.port, await readControllerToolFile(path.resolve(values.projection), 16 * 1024 ** 2), values.feature ?? [])
    : mode === "rollback" && values.baseline
      ? literalLaunchRollback(prior, await readCatalogPublicationBundle(path.resolve(values.baseline), deadline), values.port)
      : (() => { throw new Error("expected bind --projection or rollback --baseline"); })();
  const directory = await mkdtemp(path.join(path.resolve(values["output-parent"]), "literal-launch-"));
  for (const [name, bytes] of files) {
    const file = path.join(directory, "bundle", name);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, bytes, { mode: 0o600, flag: "wx" });
  }
  await writeFile(path.join(directory, "request.json"), json({ schema_version: 1, kind: "catalog-publication",
    compatibility: { contract: "official-definition-policy-launch-v1",
      notes: `Literal launch ${mode} for ${values.port}. Require exact capable released-client validation and independent review of all unchanged publisher and launch scope bindings before signing.`,
    },
  }), { mode: 0o600, flag: "wx" });
  process.stdout.write(`${directory}\n`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

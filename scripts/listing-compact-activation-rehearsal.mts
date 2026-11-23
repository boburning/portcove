/** Rehearse compact format-15 listing activation through the production
 * preparation entry point (`prepareObservationBundle`) without signing or
 * publishing. Each step runs the real preparation code against a fixture prior
 * repository; the Core CLI it is given projects, exports and validates. Nothing
 * here reads a key, Pages or a release: activation selects its reader through
 * the production automatic selection over fixture Pages, release and
 * attestation sources. The release-tools signer rules are exercised separately
 * by the release-tools tests. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { observationHash } from "./upstream-observer.mts";
import {
  compactListingCarrier,
  compactListingDeliveryTarget,
  decodeRetainedCompactListing,
  listingDeliveryTarget,
} from "./listing-directory-carrier.mts";
import { prepareObservationBundle } from "./listing-observation-delivery.mts";
import { acquireCatalogReleasedReader } from "./catalog-released-reader.mts";
import { fixtureReleasedReaderSources } from "./fixtures/released-reader-fixture.mts";
import type { ReleasedReaderFixture } from "./fixtures/released-reader-fixture.mts";
import type { UpstreamInput } from "./maintenance-upstream.mts";
import { fixtureListing, fixturePolicy } from "./fixtures/listing-observation-delivery-fixture.mts";
import { checkpoint, keyOf, progress } from "./fixtures/upstream-checkpoint-fixture.mts";

export const compactActivationFormat = 15;
const legacyFormat = 11;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

type Row = Record<string, unknown> & { id: string };
interface Directory {
  format_version: number;
  listings: Row[];
}
interface Delivery {
  revision: number;
  withdrawn_ids: string[];
  directory: Directory;
}
const read = (bytes: Buffer) => JSON.parse(bytes.toString("utf8")) as Delivery;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const rows = (bytes: Buffer) => new Map(read(bytes).directory.listings.map((row) => [row.id, row]));

interface Restriction {
  id: string;
  effect: string;
  operations: string[];
  scope?: unknown;
  reason?: string;
  explanation?: string;
  reconsider_when?: unknown;
  tracking_issue?: number;
}

/** Typed restriction detail a format-11 reader cannot receive. The format-11
 * string is the first download hold's explanation and holds the whole row. */
export function restrictionsNotExpressibleToLegacy(canonical: Directory) {
  const entries: { listing: string; restriction: string; lost: string[] }[] = [];
  for (const row of canonical.listings) {
    if (!Array.isArray(row.restrictions)) continue;
    const restrictions = row.restrictions as Restriction[];
    const first = restrictions.find(
      (restriction) => restriction.effect === "hold" && restriction.operations.includes("download"),
    );
    for (const restriction of restrictions) {
      const lost: string[] = [];
      if (restriction.effect !== "hold") lost.push(`effect:${restriction.effect}`);
      for (const operation of restriction.operations)
        if (operation !== "download") lost.push(`operation:${operation}`);
      if (restriction.scope !== undefined) lost.push("scope (format 11 holds the whole listing)");
      if (restriction.effect === "hold" && restriction !== first)
        lost.push("explanation (only the first download hold's text is carried)");
      for (const field of ["reason", "reconsider_when", "tracking_issue"] as const)
        if (restriction[field] !== undefined) lost.push(field);
      if (lost.length) entries.push({ listing: row.id, restriction: restriction.id, lost });
    }
  }
  const summary: Record<string, number> = {};
  for (const entry of entries)
    for (const field of entry.lost) summary[field] = (summary[field] ?? 0) + 1;
  const holdLost = entries.filter((entry) =>
    entry.lost.some((field) => field.startsWith("effect:") || field.startsWith("operation:")),
  );
  return { entries, summary, hold_semantics_lost: holdLost.map((entry) => entry.listing) };
}

/** A Node executable script, run by the absolute path of this Node binary. */
function executable(file: string, body: string) {
  writeFileSync(file, `#!${process.execPath}\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

/** A `--json capabilities` reader that reports exactly these capabilities. */
function capabilityReader(file: string, formats: number[], carriers: string[]) {
  return executable(
    file,
    `process.stdout.write(${JSON.stringify(
      JSON.stringify({
        ok: true,
        command: "capabilities",
        data: {
          product: "Portcove",
          product_version: "0.1.0",
          listing_formats: formats,
          listing_delivery_carriers: carriers,
        },
      }),
    )});`,
  );
}

/** Stands in for `portcove-release-tools verify-definition-repository`: it
 * reports the fixture prior repository's file inventory. No signature exists
 * to verify; the signer's own history checks are covered by release-tools. */
export function fixtureVerifier(file: string) {
  return executable(
    file,
    `const { createHash } = require("node:crypto");
const fs = require("node:fs"), path = require("node:path");
const config = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const files = [];
const walk = (dir) => { for (const name of fs.readdirSync(dir).sort()) {
  const full = path.join(dir, name);
  if (fs.statSync(full).isDirectory()) walk(full);
  else { const bytes = fs.readFileSync(full);
    files.push({ target: path.relative(config.repository, full).split(path.sep).join("/"),
      sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length }); } } };
walk(config.repository);
process.stdout.write(JSON.stringify({ schema_version: 1, authority: "none", files }));`,
  );
}

/** A prior repository layout with these listing targets in its policy role. */
export function writePriorRepository(root: string, targets: Record<string, Buffer>) {
  const metadata = path.join(root, "metadata");
  mkdirSync(metadata, { recursive: true });
  const write = (name: string, value: unknown) =>
    writeFileSync(path.join(metadata, name), JSON.stringify(value));
  write("timestamp.json", { signed: { version: 1, meta: { "snapshot.json": { version: 1 } } } });
  write("1.snapshot.json", {
    signed: {
      meta: { "official-definitions.json": { version: 1 }, "official-policy.json": { version: 1 } },
    },
  });
  write("1.official-definitions.json", { signed: { targets: {} } });
  const policy: Record<string, unknown> = {};
  for (const [name, bytes] of Object.entries(targets)) {
    const digest = hash(bytes);
    policy[name] = { hashes: { sha256: digest }, length: bytes.length };
    const file = path.join(root, "targets", `${digest}.${name}`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  }
  write("1.official-policy.json", { signed: { targets: policy } });
  return root;
}

/** Two discovery rows on one observed source, for the enrichment step. */
export function enrichmentFixture(invalidField = "unexpected_field") {
  const valid = { ...fixtureListing, id: "rehearsal-valid-observation" };
  const invalid = { ...fixtureListing, id: "rehearsal-invalid-observation" };
  const policies = [fixturePolicy(valid), fixturePolicy(invalid)];
  const corrupt = structuredClone(policies[1]!);
  // Core's observation schema refuses unknown fields.
  corrupt.listing_update.upstream_observation[invalidField] = true;
  const input = (candidates: typeof policies): UpstreamInput => ({
    revision: "rehearsal-observer-run",
    config_sha256: "a".repeat(64),
    checkpoint: checkpoint({
      [keyOf("owner/game")]: progress("owner/game", [], {
        repository_id: 42,
        last_complete_facts_sha256: candidates[0]!.facts_sha256,
        last_complete_policies: candidates,
      }),
    }),
    catalog: { ports: [], listings: [valid, invalid] },
  });
  return {
    rows: [valid, invalid] as Row[],
    policies,
    valid: valid.id,
    invalid: invalid.id,
    validInput: input(policies),
    mixedInput: input([policies[0]!, corrupt]),
  };
}

export interface RehearsalOptions {
  /** Core CLI that exports and validates (a locally built `portcove`). */
  cli: string;
  /** The publication bundle preparation copies (definitions and policies). */
  bundle: string;
  /** Canonical listings.json at the compact activation format. */
  canonical: string;
  catalog: string;
  /** Empty scratch directory for fixtures and every preparation output. */
  workspace: string;
  /** The reader the fixture release publishes; the `cli` itself otherwise. */
  releasedReader?: string;
}

/** The version a reader reports, which its fixture release is published as. */
function reportedVersion(reader: string) {
  const report = JSON.parse(
    execFileSync(reader, ["--json", "capabilities"], { encoding: "utf8", maxBuffer: 1024 * 1024 }),
  ) as { data?: { product_version?: unknown } };
  const version = report.data?.product_version;
  if (typeof version !== "string") throw new Error("Rehearsal reader reports no version");
  return version;
}

export async function rehearseCompactActivation(options: RehearsalOptions) {
  const { workspace } = options;
  mkdirSync(workspace, { recursive: true });
  if (readdirSync(workspace).length) throw new Error("Rehearsal workspace must be empty");
  const fixtures = path.join(workspace, "fixtures");
  mkdirSync(fixtures);
  const tools = fixtureVerifier(path.join(fixtures, "verify-definition-repository"));
  const root = path.join(fixtures, "root.json");
  const offlineTargets = path.join(fixtures, "offline-targets.json");
  writeFileSync(root, "{}");
  writeFileSync(offlineTargets, "{}");
  const canonicalBytes = readFileSync(options.canonical);
  const canonical = JSON.parse(canonicalBytes.toString("utf8")) as Directory;
  if (canonical.format_version !== compactActivationFormat)
    throw new Error(`Rehearsal requires the canonical format-${compactActivationFormat} directory`);
  const readerPath = options.releasedReader ?? options.cli;
  const releasedReader = { cli: readerPath, sha256: hash(readFileSync(readerPath)) };
  const readerBinary = readFileSync(readerPath);
  const readerVersion = reportedVersion(readerPath);
  const canonicalFile = (name: string, directory: Directory) => {
    const file = path.join(fixtures, `${name}.listings.json`);
    writeFileSync(file, JSON.stringify(directory));
    return file;
  };
  const run = async (
    name: string,
    step: {
      prior: string | null;
      canonical?: string;
      compact?: boolean;
      returnToLegacy?: boolean;
      reader?: { cli: string; sha256: string };
      /** Automatic selection over these fixture release sources. */
      official?: Omit<ReleasedReaderFixture, "version"> & { version?: string };
      observation?: UpstreamInput;
    },
  ) => {
    const output = path.join(workspace, name);
    const official = step.official;
    await prepareObservationBundle({
      bundle: options.bundle,
      canonical: step.canonical ?? options.canonical,
      catalog: options.catalog,
      prior: step.prior,
      output,
      cli: options.cli,
      tools,
      root,
      offlineTargets,
      observe: step.observation !== undefined,
      ...(step.observation ? { readObservation: () => Promise.resolve(step.observation!) } : {}),
      ...(official
        ? {
            officialReleasedReader: true,
            acquireReleasedReader: (root: string) =>
              acquireCatalogReleasedReader(
                root,
                fixtureReleasedReaderSources({
                  ...official,
                  version: official.version ?? readerVersion,
                }).sources,
              ),
          }
        : {
            compact: step.compact === true,
            returnToLegacy: step.returnToLegacy === true,
            releasedReader: step.reader ?? releasedReader,
          }),
    });
    const bundle = path.join(output, "bundle");
    const compactPath = path.join(bundle, compactListingDeliveryTarget);
    const compactWire = existsSync(compactPath) ? readFileSync(compactPath) : null;
    return {
      legacy: readFileSync(path.join(bundle, listingDeliveryTarget)),
      compactWire,
      compact: compactWire ? decodeRetainedCompactListing(compactWire) : null,
      report: JSON.parse(readFileSync(path.join(output, "report.json"), "utf8")) as Record<
        string,
        unknown
      >,
    };
  };
  const repository = (name: string, result: { legacy: Buffer; compactWire: Buffer | null }) =>
    writePriorRepository(path.join(workspace, `${name}-repository`), {
      [listingDeliveryTarget]: result.legacy,
      ...(result.compactWire ? { [compactListingDeliveryTarget]: result.compactWire } : {}),
    });
  const refusal = async (action: () => Promise<unknown>) => {
    try {
      await action();
    } catch (error) {
      return message(error);
    }
    throw new Error("Rehearsal expected preparation to refuse");
  };
  const coreExport = (file: string) => {
    const result = JSON.parse(
      execFileSync(
        options.cli,
        ["--json", "catalog", "inspect-listings", "--path", file, "--format-version", "11"],
        { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      ),
    ) as { ok: boolean; data: Directory };
    if (!result.ok) throw new Error("Core could not export the format-11 projection");
    return new Map(result.data.listings.map((row) => [row.id, row]));
  };

  // (0) The last legacy-only publication before activation.
  const baseline = await run("legacy", { prior: null });
  const priorLegacy = baseline.legacy;
  const legacy = read(priorLegacy);
  if (baseline.compact || legacy.directory.format_version !== legacyFormat)
    throw new Error("Rehearsal baseline must be a format-11 legacy publication");
  const legacyRepository = repository("legacy", baseline);

  // (1) Released-reader gate, through preparation.
  const reader = (name: string, formats: number[], carriers: string[]) => {
    const cli = capabilityReader(path.join(fixtures, name), formats, carriers);
    return { cli, sha256: hash(readFileSync(cli)) };
  };
  const gate: {
    refused: Record<
      "without_compact_carrier" | "without_candidate_format" | "wrong_reader_digest",
      string
    >;
    automatic_unverified?: Record<string, { legacy_only_unchanged: boolean; reason: string }>;
  } = {
    refused: {
      without_compact_carrier: await refusal(() =>
        run("gate-carrier", {
          prior: legacyRepository,
          compact: true,
          reader: reader("reader-json", [11, 12, 13, 14, 15], ["json-v1"]),
        }),
      ),
      without_candidate_format: await refusal(() =>
        run("gate-format", {
          prior: legacyRepository,
          compact: true,
          reader: reader("reader-format-14", [11, 12, 13, 14], [compactListingCarrier]),
        }),
      ),
      wrong_reader_digest: await refusal(() =>
        run("gate-digest", {
          prior: legacyRepository,
          compact: true,
          reader: { cli: releasedReader.cli, sha256: "0".repeat(64) },
        }),
      ),
    },
  };

  // (1b) Automatic selection: a reader that cannot be verified, or does not
  // read the candidate, leaves the legacy-only publication exactly as before.
  const legacyOnly = (result: { legacy: Buffer; compactWire: Buffer | null }) =>
    result.compactWire === null && result.legacy.equals(priorLegacy);
  const unverified = {
    withdrawn: await run("automatic-withdrawn", {
      prior: legacyRepository,
      official: { binary: readerBinary, withdrawn: [readerVersion] },
    }),
    lacks_candidate_format: await run("automatic-format-14", {
      prior: legacyRepository,
      official: {
        binary: readFileSync(
          capabilityReader(
            path.join(fixtures, "automatic-format-14"),
            [11, 12, 13, 14],
            [compactListingCarrier],
          ),
        ),
        version: "0.1.0",
      },
    }),
    substituted_archive: await run("automatic-substituted", {
      prior: legacyRepository,
      official: {
        binary: readerBinary,
        mutate: (fixture) => {
          fixture.archive = Buffer.concat([fixture.archive, Buffer.from("x")]);
        },
      },
    }),
    unattested_tag: await run("automatic-tag", {
      prior: legacyRepository,
      official: {
        binary: readerBinary,
        mutate: (fixture) => {
          fixture.tagObject = "b".repeat(40);
        },
      },
    }),
    off_protected_main: await run("automatic-ancestry", {
      prior: legacyRepository,
      official: {
        binary: readerBinary,
        mutate: (fixture) => {
          fixture.ancestor = false;
        },
      },
    }),
  };
  const automaticGate = Object.fromEntries(
    Object.entries(unverified).map(([name, result]) => [
      name,
      {
        legacy_only_unchanged: legacyOnly(result),
        reason:
          typeof result.report.released_reader_unavailable === "string"
            ? result.report.released_reader_unavailable
            : "",
      },
    ]),
  );
  if (Object.values(automaticGate).some((entry) => !entry.legacy_only_unchanged || !entry.reason))
    throw new Error("An unverified automatic reader changed legacy-only publication");
  gate.automatic_unverified = automaticGate;

  // (2) Activation: the first compact publication, selected automatically.
  const activated = await run("activation", {
    prior: legacyRepository,
    official: { binary: readerBinary },
  });
  if (!activated.compact) throw new Error("Activation published no compact target");
  const compact = read(activated.compact);
  if (compact.directory.format_version !== compactActivationFormat)
    throw new Error("Rehearsal compact activation format differs");
  if (compact.revision <= legacy.revision)
    throw new Error("Compact activation must publish above the legacy revision");
  const activation = {
    legacy_revision: legacy.revision,
    compact_revision: compact.revision,
    compact_format: compact.directory.format_version,
    compact_rows: compact.directory.listings.length,
    legacy_rows: legacy.directory.listings.length,
    // Preparation retained the signed legacy bytes it read from the prior.
    legacy_target_retained: activated.legacy.equals(priorLegacy),
    legacy_sha256: hash(activated.legacy),
    released_reader: activated.report.released_reader ?? null,
    released_reader_source: activated.report.released_reader_source ?? null,
  };
  const verifiedReader = activated.report.released_reader;
  if (
    typeof verifiedReader !== "object" ||
    verifiedReader === null ||
    !("sha256" in verifiedReader) ||
    verifiedReader.sha256 !== hash(readerBinary)
  )
    throw new Error("Activation did not verify the selected released reader");
  if (!activation.legacy_target_retained)
    throw new Error("Activation changed the signed legacy target");
  const activeRepository = repository("activation", activated);
  const notExpressible = restrictionsNotExpressibleToLegacy(canonical);

  // (3) A hold added after activation reaches format-11 readers.
  const legacyRows = rows(priorLegacy);
  const isHeld = (row: Row | undefined) =>
    typeof row?.download_block_reason === "string" && row.download_block_reason.length > 0;
  const deliveredOpen = legacy.directory.listings.find((row) => !isHeld(row));
  const bundledOpen = canonical.listings.find((row) => !legacyRows.has(row.id) && !isHeld(row));
  const reason = "Rehearsal: fresh acquisition is held after compact activation.";
  const holdIds = [deliveredOpen?.id, bundledOpen?.id].filter((id): id is string => !!id);
  const heldCanonical: Directory = {
    ...canonical,
    listings: canonical.listings.map((row) =>
      holdIds.includes(row.id)
        ? {
            ...row,
            download_block_reason: reason,
            restrictions: [
              ...(Array.isArray(row.restrictions) ? (row.restrictions as unknown[]) : []),
              {
                id: "rehearsal-hold",
                effect: "hold",
                operations: ["download"],
                reason: "known-defective-artifact",
                explanation: reason,
              },
            ],
          }
        : row,
    ),
  };
  // Core orders a row's restrictions; the legacy string is the first download hold's text.
  const heldFile = canonicalFile("held", heldCanonical);
  const held = await run("hold", { prior: activeRepository, canonical: heldFile });
  const heldLegacy = rows(held.legacy);
  const heldCompact = held.compact ? rows(held.compact) : new Map<string, Row>();
  const compactHeld = (id: string) => heldCompact.get(id)?.download_block_reason;
  const newHold = {
    delivered_row: deliveredOpen?.id ?? null,
    bundled_row: bundledOpen?.id ?? null,
    automatic_legacy_holds: held.report.automatic_legacy_holds as string[],
    automatic_legacy_rows: held.report.automatic_legacy_rows as string[],
    legacy_revision: read(held.legacy).revision,
    compact_revision: held.compact ? read(held.compact).revision : null,
    // Each legacy hold is the compact row's legacy hold of the same publication.
    legacy_holds_match_compact: holdIds.every(
      (id) =>
        typeof heldLegacy.get(id)?.download_block_reason === "string" &&
        heldLegacy.get(id)?.download_block_reason === compactHeld(id),
    ),
    // An added row is Core's exact format-11 export of that listing.
    added_rows_equal_core_export: (() => {
      const exported = coreExport(heldFile);
      return [...heldLegacy].every(
        ([id, row]) =>
          legacyRows.has(id) || observationHash(exported.get(id)) === observationHash(row),
      );
    })(),
    other_legacy_rows_unchanged: [...legacyRows].every(
      ([id, row]) =>
        holdIds.includes(id) || observationHash(heldLegacy.get(id)) === observationHash(row),
    ),
  };
  if (
    observationHash(newHold.automatic_legacy_holds) !==
      observationHash(deliveredOpen ? [deliveredOpen.id] : []) ||
    observationHash(newHold.automatic_legacy_rows) !==
      observationHash(bundledOpen ? [bundledOpen.id] : []) ||
    !newHold.legacy_holds_match_compact ||
    !newHold.added_rows_equal_core_export ||
    !newHold.other_legacy_rows_unchanged
  )
    throw new Error("A hold added after activation did not reach the legacy target");
  // Releasing the hold in the catalog never loosens the legacy target.
  const released = await run("hold-released", { prior: repository("hold", held) });
  const releasedLegacy = rows(released.legacy);
  const holdKept = holdIds.every(
    (id) =>
      releasedLegacy.get(id)?.download_block_reason === heldLegacy.get(id)?.download_block_reason,
  );
  if (!holdKept) throw new Error("A released catalog hold loosened the legacy target");

  // (4) Invalid optional enrichment: Core validation, compact isolation and
  // the legacy all-or-nothing fallback.
  const enrichment = enrichmentFixture();
  const enriched = canonicalFile("enriched", {
    ...canonical,
    listings: [...canonical.listings, ...enrichment.rows],
  });
  const observed = (bytes: Buffer, id: string) => rows(bytes).get(id)?.upstream_observation;
  const first = await run("enrichment-valid", {
    prior: activeRepository,
    canonical: enriched,
    observation: enrichment.validInput,
  });
  const second = await run("enrichment-mixed", {
    prior: repository("enrichment-valid", first),
    canonical: enriched,
    observation: enrichment.mixedInput,
  });
  const legacyMixed = await run("enrichment-legacy", {
    prior: legacyRepository,
    canonical: enriched,
    observation: enrichment.mixedInput,
  });
  const enrichmentResult = {
    compact_excluded: second.report.excluded_candidates,
    compact_valid_observed: observed(second.compact!, enrichment.valid) !== undefined,
    compact_invalid_keeps_prior_observation:
      observationHash(observed(second.compact!, enrichment.invalid)) ===
        observationHash(observed(first.compact!, enrichment.invalid)) &&
      observed(first.compact!, enrichment.invalid) !== undefined,
    legacy_fallback_diagnostic: (legacyMixed.report.diagnostics as string[]).find((line) =>
      line.includes("observer candidates failed Core validation"),
    ),
    legacy_publishes_neither_candidate:
      observed(legacyMixed.legacy, enrichment.valid) === undefined &&
      observed(legacyMixed.legacy, enrichment.invalid) === undefined,
  };
  if (
    observationHash(enrichmentResult.compact_excluded) !== observationHash([enrichment.invalid]) ||
    !enrichmentResult.compact_valid_observed ||
    !enrichmentResult.compact_invalid_keeps_prior_observation ||
    !enrichmentResult.legacy_fallback_diagnostic ||
    !enrichmentResult.legacy_publishes_neither_candidate
  )
    throw new Error(
      "Invalid optional enrichment was not handled: " + JSON.stringify(enrichmentResult),
    );

  // (5) Reviewed return to legacy-only delivery.
  const returned = await run("return", { prior: activeRepository, returnToLegacy: true });
  const returnedDocument = read(returned.legacy);
  const rollback = {
    compact_revision: compact.revision,
    legacy_revision: legacy.revision,
    return_revision: returnedDocument.revision,
    return_format: returnedDocument.directory.format_version,
    compact_target_removed: returned.compactWire === null,
    withdrawals_kept: compact.withdrawn_ids.every((id) =>
      returnedDocument.withdrawn_ids.includes(id),
    ),
    compact_requires_reviewed_input: await refusal(() =>
      run("return-with-compact", { prior: activeRepository, returnToLegacy: true, compact: true }),
    ),
    legacy_only_prior_refused: await refusal(() =>
      run("return-without-compact", { prior: legacyRepository, returnToLegacy: true }),
    ),
  };
  if (
    !rollback.compact_target_removed ||
    rollback.return_revision <= rollback.compact_revision ||
    rollback.return_format !== legacyFormat ||
    !rollback.withdrawals_kept
  )
    throw new Error("Legacy-only return would lose reader freshness");

  return {
    scope:
      "rehearsal through prepareObservationBundle; nothing is signed, published or activated. The prior repository is a fixture whose verification report is its file inventory.",
    activation_format: compactActivationFormat,
    reader_gate: gate,
    activation,
    not_expressible_to_format_11: notExpressible,
    new_hold_after_activation: { ...newHold, released_catalog_hold_kept: holdKept },
    enrichment: enrichmentResult,
    rollback,
    remaining: [
      "Signer admission of these proposals is covered by release-tools tests, not by this rehearsal.",
      "After history bootstrap the checkpoint still refuses a legacy-only return.",
    ],
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      cli: { type: "string" },
      workspace: { type: "string" },
      bundle: { type: "string", default: "release/catalog-publication/bundle" },
      catalog: { type: "string", default: "crates/portcove-core/catalog" },
      "released-reader": { type: "string" },
    },
  });
  if (!values.cli) throw new Error("--cli PATH (a locally built portcove CLI) is required");
  if (!values.workspace) throw new Error("--workspace PATH (an empty directory) is required");
  const directory = path.resolve(values.catalog);
  const report = await rehearseCompactActivation({
    cli: path.resolve(values.cli),
    bundle: path.resolve(values.bundle),
    canonical: path.join(directory, "listings.json"),
    catalog: path.join(directory, "catalog.json"),
    workspace: path.resolve(values.workspace),
    ...(values["released-reader"]
      ? { releasedReader: path.resolve(values["released-reader"]) }
      : {}),
  });
  console.log(JSON.stringify(report, null, 2));
}

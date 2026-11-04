import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, cpSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { preparePort } from "./prepare-port.mts";
import test from "node:test";
import { checkedAuthoredPort, assembleCatalogRecords } from "./catalog-authoring.mts";
import {
  acceptPackagePlayerObservation,
  packagePlayerProjection,
  packagePlayerProjectionKey,
  projectPackagePlayerFacts,
  acceptedPlayerRouteExpectations,
} from "./package-player-observation.mts";
import { isRecord } from "./runtime-values.mts";
const id = "mother-3-mother-3-recomp";
function record() {
  const raw: unknown = JSON.parse(
    readFileSync(`crates/portcove-core/catalog/ports/${id}.json`, "utf8"),
  );
  assert.ok(isRecord(raw) && isRecord(raw.listing));
  raw.route_facts_v1 = {
    format_version: 1,
    prepared_player: {
      executable: "Mother3Recomp.exe",
      working_directory: "executable-parent",
      arguments: [],
      data_locations: ["owned external profile"],
    },
  };
  return checkedAuthoredPort(raw);
}
function row() {
  const report: unknown = JSON.parse(
    readFileSync("docs/qualification/prepared-player-cohort-r40-2026-11-01.json", "utf8"),
  );
  assert.ok(isRecord(report) && Array.isArray(report.rows));
  const result: unknown = report.rows.find((value: unknown) => isRecord(value) && value.id === id);
  assert.ok(isRecord(result));
  return structuredClone(result);
}
const reference = "docs/qualification/prepared-player-cohort-r40-2026-11-01.json";
void test("actual accepted Mother3 package/player observation supplies descriptive Windows metadata", () => {
  const input = record(),
    observed = acceptPackagePlayerObservation(input, row(), reference);
  assert.equal(
    observed.artifact.sha256,
    "8f27d1ab97a66b1a6d5201c56eaf89832a699c711f0555d56e1d84f3ddf03d9d",
  );
  assert.equal(
    observed.player.sha256,
    "347210ae76b140cca86e6a56984d16276798b8d675120495f05c907fc8ed8655",
  );
  delete input.listing.platforms;
  input.package_observation_v1 = observed;
  const projected = projectPackagePlayerFacts(checkedAuthoredPort(input));
  assert.deepEqual(projected.listing.platforms, ["windows-x86-64"]);
  assert.equal(projected.integration, undefined);
  assert.equal(projected.listing.availability, "unknown");
  const shared: unknown = JSON.parse(
    readFileSync("crates/portcove-core/catalog/catalog-shared.json", "utf8"),
  );
  const output = assembleCatalogRecords(shared, [input]);
  assert.deepEqual(output.directory.listings[0]?.platforms, ["windows-x86-64"]);
  assert.equal(output.catalog.ports.length, 0);
  assert.ok(!("package_observation_v1" in output.directory.listings[0]));
});
void test("installer header cannot substitute for an absent selected child player", () => {
  const raw = row();
  const entries = raw.selected_executables;
  assert.ok(Array.isArray(entries));
  const child: unknown = entries[0];
  assert.ok(isRecord(child));
  child.path = "package/Setup.exe";
  assert.throws(
    () => acceptPackagePlayerObservation(record(), raw, reference),
    /missing or ambiguous/,
  );
});
void test("partial member coverage and wrong archive identity supply no accepted projection", () => {
  for (const kind of ["crc", "archive", "raw-inventory"]) {
    const raw = row();
    if (kind === "archive") raw.observed_archive_sha256 = "f".repeat(64);
    else if (kind === "raw-inventory") raw.raw_preparser = { raw_names_bound_before_parser: false };
    else {
      assert.ok(Array.isArray(raw.selected_executables) && isRecord(raw.selected_executables[0]));
      raw.selected_executables[0].full_member_CRC_verified = false;
    }
    assert.throws(() => acceptPackagePlayerObservation(record(), raw, reference));
  }
});
void test("ambiguous matching player paths are withheld rather than selecting the first header", () => {
  const raw = row();
  assert.ok(Array.isArray(raw.selected_executables));
  raw.selected_executables.push(structuredClone(raw.selected_executables[0]));
  assert.throws(() => acceptPackagePlayerObservation(record(), raw, reference), /ambiguous/);
});
void test("changed route selection invalidates this descriptive result without granting support", () => {
  const input = record(),
    observed = acceptPackagePlayerObservation(input, row(), reference);
  input.route_facts_v1!.prepared_player.arguments = ["launch-a-different-child"];
  const projected = packagePlayerProjection(input, observed);
  assert.equal(projected.status, "inapplicable");
  assert.deepEqual(projected.platforms, []);
  input.package_observation_v1 = observed;
  assert.throws(
    () => acceptedPlayerRouteExpectations([input]),
    /needs an accepted observation bound to its changed selection contract/,
  );
});
void test("unrelated prose/data details preserve applicable evidence; selected inputs and validator changes invalidate its key", () => {
  const input = record(),
    raw = row(),
    observed = acceptPackagePlayerObservation(input, raw, reference);
  const initial = packagePlayerProjectionKey(input, observed);
  input.listing.summary = "Editorial description changed.";
  input.route_facts_v1!.prepared_player.data_locations = ["another descriptive profile location"];
  assert.equal(packagePlayerProjectionKey(input, observed), initial);
  const changedRow = row();
  changedRow.unrelated_notes =
    "Later narration does not re-date or re-inspect these package bytes.";
  const unchanged = acceptPackagePlayerObservation(input, changedRow, reference);
  assert.equal(unchanged.scope_sha256, observed.scope_sha256);
  assert.equal(packagePlayerProjectionKey(input, unchanged), initial);
  assert.notEqual(
    packagePlayerProjectionKey(input, observed, {
      id: "accepted-package-player-header-v1",
      sha256: "a".repeat(64),
    }),
    initial,
  );
  const changed = record();
  changed.route_facts_v1!.prepared_player.executable = "different.exe";
  assert.notEqual(packagePlayerProjectionKey(changed, observed), initial);
});

void test("a new artifact invalidates its scoped receipt while changed bytes under recorded identity refuse", () => {
  const input = record(),
    original = acceptPackagePlayerObservation(input, row(), reference);
  input.package_observation_v1 = original;
  const changed = row();
  assert.ok(isRecord(changed.official_asset));
  changed.observed_archive_sha256 = "b".repeat(64);
  changed.official_asset.digest = `sha256:${"b".repeat(64)}`;
  assert.throws(() => acceptPackagePlayerObservation(input, changed, reference), /same package/);
  const cased = structuredClone(input);
  cased.listing.project_url = cased.listing.project_url
    .toUpperCase()
    .replace("HTTPS://GITHUB.COM", "https://github.com");
  const casedRow = structuredClone(changed);
  casedRow.source_repository = String(casedRow.source_repository).toUpperCase();
  assert.throws(() => acceptPackagePlayerObservation(cased, casedRow, reference), /same package/);
  changed.official_asset.id = 685948203;
  const next = acceptPackagePlayerObservation(input, changed, reference);
  assert.notEqual(
    packagePlayerProjectionKey(input, next),
    packagePlayerProjectionKey(input, original),
  );
});
void test("unknown header architecture is unknown descriptive coverage and object reordering does not change scope", () => {
  const input = record(),
    raw = row();
  assert.ok(Array.isArray(raw.selected_executables));
  const player: unknown = raw.selected_executables[0];
  assert.ok(isRecord(player) && isRecord(player.pe_prefix));
  player.pe_prefix.machine = "0x014c";
  const observed = acceptPackagePlayerObservation(input, raw, reference);
  const output = packagePlayerProjection(input, observed);
  assert.equal(output.status, "unknown");
  assert.deepEqual(output.platforms, []);
  input.package_observation_v1 = observed;
  const expected = acceptedPlayerRouteExpectations([input]);
  assert.equal(
    expected.cases.length,
    1,
    "unknown architecture cannot erase declared lifecycle coverage",
  );
  assert.equal(expected.cases[0]?.executable, "Mother3Recomp.exe");
  const reordered = {
    ...observed,
    artifact: {
      sha256: observed.artifact.sha256,
      bytes: observed.artifact.bytes,
      url: observed.artifact.url,
      name: observed.artifact.name,
      id: observed.artifact.id,
    },
  };
  assert.equal(
    packagePlayerProjectionKey(input, reordered),
    packagePlayerProjectionKey(input, observed),
  );
});

void test("ordinary preparation reuses accepted evidence and fences omitted or replaced prior identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "portcove-package-projection-"));
  try {
    const catalogRoot = join(root, "catalog");
    cpSync(resolve("crates/portcove-core/catalog"), catalogRoot, { recursive: true });
    const original = record();
    delete original.listing.platforms;
    original.package_observation_v1 = acceptPackagePlayerObservation(original, row(), reference);
    const before = structuredClone(original);
    delete before.package_observation_v1;
    writeFileSync(join(catalogRoot, "ports", `${id}.json`), JSON.stringify(before));
    const changed = row();
    assert.ok(isRecord(changed.official_asset));
    changed.observed_archive_sha256 = "c".repeat(64);
    changed.official_asset.digest = `sha256:${"c".repeat(64)}`;
    let requests = 0;
    const options = {
      catalogRoot,
      outputDirectory: join(root, "prepared"),
      id,
      packageObservation: { receipt: row(), reference },
      facts: {
        fetcher: (async () => {
          requests++;
          return new Response(
            JSON.stringify({
              id: 1414469189,
              full_name: "josiahg2502-glitch/Mother3Recomp",
              name: "Mother3Recomp",
            }),
            { status: 200 },
          );
        }) as typeof fetch,
      },
      artwork: { inspectGame: () => [] },
    };
    const first = await preparePort(options);
    const second = await preparePort(options);
    assert.ok(isRecord(first.report.package_observation));
    assert.ok(isRecord(second.report.package_observation));
    assert.equal(first.report.package_observation.reused, false);
    assert.equal(second.report.package_observation.reused, true);
    assert.equal(
      requests,
      1,
      "unchanged provider facts and projection reuse owned checkpoint entries",
    );
    const proposal = checkedAuthoredPort(
      JSON.parse(readFileSync(first.report.files.records[0]!.path, "utf8")),
    );
    assert.equal(proposal.listing.platforms, undefined, "no second authored platform authority");
    assert.deepEqual(projectPackagePlayerFacts(proposal).listing.platforms, ["windows-x86-64"]);
    const expected = acceptedPlayerRouteExpectations([proposal]);
    assert.equal(expected.cases[0]?.executable, "Mother3Recomp.exe");
    assert.equal(
      expected.cases[0]?.observation_scope_sha256,
      original.package_observation_v1.scope_sha256,
    );
    writeFileSync(join(catalogRoot, "ports", `${id}.json`), JSON.stringify(original));
    for (const replacement of [false, true]) {
      const explicit = structuredClone(original);
      if (replacement) {
        delete explicit.package_observation_v1;
        explicit.package_observation_v1 = acceptPackagePlayerObservation(
          explicit,
          changed,
          reference,
        );
      } else delete explicit.package_observation_v1;
      const explicitOnly: Parameters<typeof preparePort>[0] = { ...options, record: explicit };
      delete explicitOnly.packageObservation;
      if (replacement) {
        await assert.rejects(preparePort(explicitOnly), /same package\/member identity/);
      } else {
        const retained = await preparePort(explicitOnly);
        assert.deepEqual(
          retained.report.changed_records,
          [],
          "omitting an observation preserves accepted evidence",
        );
      }
      await assert.rejects(
        preparePort({
          ...options,
          record: explicit,
          packageObservation: { receipt: changed, reference },
        }),
        /same package\/member identity/,
      );
    }
    const next = structuredClone(changed);
    assert.ok(isRecord(next.official_asset));
    next.official_asset.id = 685948204;
    const third = await preparePort({
      ...options,
      packageObservation: { receipt: next, reference },
    });
    assert.ok(isRecord(third.report.package_observation));
    assert.equal(
      third.report.package_observation.reused,
      false,
      "a distinct artifact cannot reuse old validation",
    );
    assert.notEqual(
      third.report.package_observation.cache_key,
      first.report.package_observation.cache_key,
    );
    const edited = structuredClone(proposal);
    edited.route_facts_v1!.prepared_player.arguments = ["another-player-mode"];
    assert.equal(
      packagePlayerProjection(edited, edited.package_observation_v1!).status,
      "inapplicable",
    );
    assert.notEqual(
      packagePlayerProjectionKey(edited, edited.package_observation_v1!),
      first.report.package_observation.cache_key,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("actual changed validator module bytes invalidate only the derived projection identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "portcove-observation-validator-"));
  try {
    cpSync(resolve("scripts/runtime-values.mts"), join(root, "runtime-values.mts"));
    const source = readFileSync("scripts/package-player-observation.mts", "utf8");
    const firstPath = join(root, "validator-first.mts"),
      secondPath = join(root, "validator-next.mts");
    writeFileSync(firstPath, source);
    writeFileSync(secondPath, source + "\n// Controlled validator implementation revision.\n");
    const first = (await import(
      pathToFileURL(firstPath).href
    )) as typeof import("./package-player-observation.mts");
    const second = (await import(
      pathToFileURL(secondPath).href
    )) as typeof import("./package-player-observation.mts");
    const input = record(),
      observed = acceptPackagePlayerObservation(input, row(), reference);
    assert.notEqual(
      first.packageProjectionValidator.sha256,
      second.packageProjectionValidator.sha256,
    );
    assert.notEqual(
      first.packagePlayerProjectionKey(input, observed),
      second.packagePlayerProjectionKey(input, observed),
    );
    assert.equal(first.packagePlayerProjection(input, observed).status, "observed");
    assert.equal(second.packagePlayerProjection(input, observed).status, "observed");
    assert.equal(
      observed.provenance.reference,
      reference,
      "revalidation retains actual inspection provenance",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import { checkCatalogAdvisories } from "./catalog-advisories.mts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  authoringRecordFromPort,
  readCatalogSource,
  assembleCatalogRecords,
  checkedAuthoredPort,
  checkedCurrentCatalog,
  compactGbaArchive,
  parseCatalogSource,
  projectAuthoredPort,
  projectGbaArchive,
} from "./catalog-authoring.mts";
import type { AuthoredPort } from "./catalog-authoring.mts";
import {
  compactN64RecompPersistence,
  projectN64RecompPersistence,
} from "./catalog-n64-recomp-persistence.mts";
import {
  compactPsxManagedWindows,
  projectPsxManagedWindows,
} from "./catalog-psx-managed-windows.mts";
import {
  compactRazeWindowsProfile,
  projectRazeWindowsProfile,
} from "./catalog-raze-windows-profile.mts";
import {
  compactOpenMohaaPortable,
  projectOpenMohaaPortable,
} from "./catalog-openmohaa-portable.mts";
import { estimateHealthRequests } from "./check-catalog-repositories.mts";
import { listingDeclarationHash } from "./listing-upstream-observation.mts";
import {
  compactCrispyDoomWindowsPersistence,
  projectCrispyDoomWindowsPersistence,
} from "./catalog-crispy-doom-windows-persistence.mts";
import {
  compactReflectionHlePortablePaths,
  projectReflectionHlePortablePaths,
} from "./catalog-portable-reflectionhle.mts";

import {
  requiredFixture,
  fixtureJson,
  fixtureCatalog,
  catalogRoot,
  record as fixtureRecord,
  records as fixtureRecords,
} from "./fixtures/catalog-generator-fixtures.mts";

const schema2Fixture = fixtureJson(
  readFileSync(join(catalogRoot, "catalog-schema2-migration-fixture.json")),
);
const schema3Fixture = fixtureJson(readFileSync(join(catalogRoot, "catalog.json")));

void test("managed platform warnings are checked and stay outside definition projections", () => {
  const authored = checkedAuthoredPort(
    fixtureJson(readFileSync(join(catalogRoot, "ports", "snap64-recomp.json"))),
  );
  const warnings = requiredFixture(authored.managed_setup_platform_warnings);
  assert.equal(warnings["windows-x86-64"], undefined);
  assert.match(requiredFixture(warnings["macos-aarch64"]?.[0]), /START HERE/u);
  const withoutWarnings = structuredClone(authored);
  delete withoutWarnings.managed_setup_platform_warnings;
  assert.deepEqual(projectAuthoredPort(authored), projectAuthoredPort(withoutWarnings));
  for (const managed_setup_platform_warnings of [
    {},
    { "android-aarch64": ["Wrong route."] },
    { "linux-x86-64": [] },
    { "linux-x86-64": ["Padded "] },
    { "linux-x86-64": ["Line one\nLine two"] },
  ]) {
    assert.throws(
      () => checkedAuthoredPort({ ...authored, managed_setup_platform_warnings }),
      /managed_setup_platform_warnings/u,
    );
  }
});

void test("current catalog schema accepts numeric 2 without guide references", () => {
  assert.equal(schema2Fixture.schema_version, 2);
  assert.doesNotThrow(() => checkedCurrentCatalog(structuredClone(schema2Fixture)));
});

void test("current catalog schema accepts numeric 3 with guide references", () => {
  assert.equal(schema3Fixture.schema_version, 3);
  assert.ok(
    fixtureRecords(schema3Fixture.ports).some((port) => {
      const presentation = fixtureRecord(port.presentation ?? {});
      const guide = fixtureRecord(presentation.manual_setup ?? {});
      return Array.isArray(guide.references) && guide.references.length > 0;
    }),
  );
  assert.doesNotThrow(() => checkedCurrentCatalog(structuredClone(schema3Fixture)));
});

void test("current catalog schema 2 still rejects nonempty guide references", () => {
  const catalog = structuredClone(schema3Fixture);
  catalog.schema_version = 2;
  assert.throws(() => checkedCurrentCatalog(catalog), {
    message: "setup references require catalog schema 3",
  });
});

for (const [label, version] of [
  ["string 2", "2"],
  ["string 3", "3"],
  ["array 2", [2]],
  ["array 3", [3]],
  ["missing version", undefined],
  ["null", null],
  ["false", false],
  ["true", true],
  ["object", {}],
  ["object with a version value", { value: 2 }],
  ["unsupported zero", 0],
  ["unsupported schema 1", 1],
  ["unsupported schema 4", 4],
  ["fractional version", 2.5],
  ["NaN", Number.NaN],
  ["infinite version", Number.POSITIVE_INFINITY],
] as const) {
  void test(`current catalog schema rejects ${label}`, () => {
    const catalog = structuredClone(schema2Fixture);
    if (version === undefined) delete catalog.schema_version;
    else catalog.schema_version = structuredClone(version);
    assert.throws(() => checkedCurrentCatalog(catalog), {
      message: "current catalog source is not schema 2 or 3",
    });
  });
}

for (const [label, version] of [
  ["string 2", "2"],
  ["array 2", [2]],
] as const) {
  void test(`current catalog schema rejects ${label} even with guide references`, () => {
    const catalog = structuredClone(schema3Fixture);
    catalog.schema_version = structuredClone(version);
    assert.throws(() => checkedCurrentCatalog(catalog), {
      message: "current catalog source is not schema 2 or 3",
    });
  });
}

void test("ordinary authoring rejects direct guides beyond Core's combined entry limit", () => {
  const source = readCatalogSource(catalogRoot);
  const record = structuredClone(
    requiredFixture(
      source.records.find(({ listing }) => listing.id === "openjkdf2-jedi-knight-dark-forces-ii"),
    ),
  );
  const guide = fixtureRecord(record.listing.manual_setup);
  const steps = fixtureRecords(guide.steps);
  const references = fixtureRecords(guide.references).slice(0, 8 - steps.length);
  guide.references = references;
  assert.equal(steps.length + references.length, 8);
  assert.doesNotThrow(() => checkedAuthoredPort(record));

  const extra = { title: "Extra reference", instruction: "Keep the current profile." };
  references.push(extra);
  assert.throws(
    () => checkedAuthoredPort(record),
    /openjkdf2.*listing.manual_setup.*eight steps and references combined/,
  );

  const catalog = structuredClone(schema3Fixture);
  const port = requiredFixture(
    fixtureRecords(catalog.ports).find(({ id }) => id === record.listing.id),
  );
  const presentation = fixtureRecord(port.presentation);
  presentation.manual_setup = { ...guide, references: references.slice(0, -1) };
  assert.doesNotThrow(() => checkedCurrentCatalog(catalog));
  presentation.manual_setup = { ...guide, references };
  assert.throws(
    () => checkedCurrentCatalog(catalog),
    /openjkdf2.*presentation.manual_setup.*eight steps and references combined/,
  );
});

void test("current authored operational routes remain valid read-only health inventory inputs", () => {
  // Core-readable prepared routes still need canonical explicit repository
  // names. Validate the whole authored inventory without fetching or waiting
  // for the slower command/report fixture; this does not assess live health.
  assert.doesNotThrow(() => estimateHealthRequests(readCatalogSource(catalogRoot).catalog));
});

void test("Crispy Doom persistence preserves all six exact Windows package layouts", () => {
  const { records } = readCatalogSource(catalogRoot);
  const prior = new Map(fixtureRecords(schema3Fixture.ports).map((entry) => [entry.id, entry]));
  const family = records.filter((record) => record.crispy_doom_windows_persistence_v1);
  assert.equal(family.length, 6);
  for (const record of family) {
    const projected = projectAuthoredPort(record);
    assert.equal(JSON.stringify(projected), JSON.stringify(prior.get(record.listing.id)));
    const explicit = projectCrispyDoomWindowsPersistence(record);
    delete explicit.crispy_doom_windows_persistence_v1;
    assert.deepEqual(compactCrispyDoomWindowsPersistence(explicit), record);
    const alternate = structuredClone(explicit);
    alternate.integration!.persistent_file_patterns = [];
    assert.equal(compactCrispyDoomWindowsPersistence(alternate), alternate);
    alternate.crispy_doom_windows_persistence_v1 = true;
    assert.throws(() => checkedAuthoredPort(alternate), /already owns the persistent paths/u);
  }
  const startedWithOtherArguments = structuredClone(requiredFixture(family[0]));
  startedWithOtherArguments.integration!.launch_arguments = [
    "-game",
    "doom",
    "-savedir",
    "another-folder",
  ];
  assert.throws(
    () => checkedAuthoredPort(startedWithOtherArguments),
    /requires the reviewed Windows portable data route/u,
  );
});

void test("Raze Windows authoring preserves the exact shared package and profile facts", () => {
  const { records } = readCatalogSource(catalogRoot);
  const family = records.filter((record) => record.raze_windows_profile_v1);
  assert.equal(family.length, 7);
  for (const record of family) {
    const projected = requiredFixture(projectAuthoredPort(record));
    assert.deepEqual(projected.release, {
      repository: "ZDoom/Raze",
      asset_hints: { "windows-x86-64": ["Raze-", "-windows.zip"] },
    });
    assert.deepEqual(projected.executable_hints, { "windows-x86-64": ["raze.exe"] });
    assert.deepEqual(projected.persistent_paths, [
      "raze_portable.ini",
      "Save",
      "Screenshots",
      "Demos",
      "autoexec.cfg",
    ]);
    assert.equal(projected.portable_marker_file, "raze_portable.ini");
    assert.deepEqual(projected.reviewed_package_layouts, {
      "windows-x86-64": { directories: ["soundfonts"], executables: ["raze.exe"] },
    });
    const explicit = projectRazeWindowsProfile(record);
    delete explicit.raze_windows_profile_v1;
    assert.deepEqual(compactRazeWindowsProfile(explicit), record);

    const fork = {
      ...explicit,
      listing: { ...explicit.listing, project_url: "https://github.com/example/Raze" },
    };
    assert.equal(compactRazeWindowsProfile(fork), fork);
  }

  const record = requiredFixture(family[0]);
  const differentPaths = structuredClone(record);
  differentPaths.integration!.persistent_paths = ["other-profile"];
  assert.throws(() => checkedAuthoredPort(differentPaths), /supplies its package and data paths/u);
  const differentRelease = structuredClone(record);
  differentRelease.integration!.release = { repository: "ZDoom/gzdoom" };
  assert.throws(() => checkedAuthoredPort(differentRelease), /reviewed stable ZDoom\/Raze route/u);

  const explicit = requiredFixture(records.find((entry) => entry.listing.id === "zdoom-gzdoom"));
  assert.equal(explicit.raze_windows_profile_v1, undefined);
  assert.equal(compactRazeWindowsProfile(explicit), explicit);
  assert.equal(projectAuthoredPort(explicit)?.portable_marker_file, "gzdoom_portable.ini");
});

void test("shared upstream family facts stay consistent while game and permission facts remain independent", () => {
  const source = readCatalogSource(catalogRoot);
  const razeUrl = "https://github.com/ZDoom/Raze";
  const namcoUrl = "https://github.com/spacestate1/namco22-decompile";
  const families = source.records.filter((entry) =>
    [razeUrl, namcoUrl].includes(entry.listing.project_url),
  );
  const profileTitle = "Keep the shared profile this game uses";
  const ownershipTitle = "Keep upstream update ownership and platform handoffs";
  const sharedGuideParts = (listing: AuthoredPort["listing"]) => {
    const guide = fixtureRecord(listing.manual_setup);
    const steps = fixtureRecords(guide.steps);
    const references = fixtureRecords(guide.references ?? []);
    const profile = references.filter((step) => step.title === profileTitle);
    const ownership = steps.filter((step) => step.title === ownershipTitle);
    assert.equal(profile.length, 1, `${listing.id}: shared profile reference`);
    assert.equal(ownership.length, 1, `${listing.id}: shared ownership action`);
    assert.equal(
      steps.some((step) => step.title === profileTitle),
      false,
      `${listing.id}: shared profile belongs in references`,
    );
    assert.equal(
      references.some((step) => step.title === ownershipTitle),
      false,
      `${listing.id}: shared ownership remains actionable`,
    );
    return { profile: requiredFixture(profile[0]), ownership: requiredFixture(ownership[0]) };
  };
  const check = (records: readonly AuthoredPort[]) => {
    for (const [url, count] of [
      [razeUrl, 7],
      [namcoUrl, 5],
    ] as const) {
      const family = records.filter((entry) => entry.listing.project_url === url);
      assert.equal(family.length, count, `Retain the reviewed independent identities for ${url}`);
      const first = requiredFixture(family[0]).listing;
      for (const { listing } of family) {
        for (const field of ["platforms", "availability", "setup_url", "release_url"] as const)
          assert.deepEqual(listing[field], first[field], `${listing.id}: shared ${field}`);
        if (url === razeUrl) {
          for (const field of ["download_asset_hints", "recommended_download_channel"] as const)
            assert.deepEqual(listing[field], first[field], `${listing.id}: shared ${field}`);
          assert.deepEqual(
            sharedGuideParts(listing),
            sharedGuideParts(first),
            `${listing.id}: shared profile and update ownership`,
          );
        }
      }
    }
  };
  check(families);
  for (const field of [
    "platforms",
    "availability",
    "setup_url",
    "release_url",
    "download_asset_hints",
    "recommended_download_channel",
    "profile",
    "ownership",
    "profile-role",
    "ownership-role",
  ] as const) {
    const changed = structuredClone(families);
    const listing = requiredFixture(
      changed.find((entry) => entry.listing.project_url === razeUrl),
    ).listing;
    if (field === "platforms") listing.platforms = ["windows-x86-64"];
    else if (field === "availability") listing.availability = "unavailable";
    else if (field === "download_asset_hints") listing.download_asset_hints = {};
    else if (field === "recommended_download_channel")
      listing.recommended_download_channel = "beta";
    else if (field === "profile" || field === "ownership")
      sharedGuideParts(listing)[field].instruction = `Wrong ${field}.`;
    else if (field === "profile-role" || field === "ownership-role") {
      const guide = fixtureRecord(listing.manual_setup);
      const from = fixtureRecords(field === "profile-role" ? guide.references : guide.steps);
      const to = fixtureRecords(field === "profile-role" ? guide.steps : guide.references);
      const title = field === "profile-role" ? profileTitle : ownershipTitle;
      const index = from.findIndex((step) => step.title === title);
      assert.notEqual(index, -1);
      to.push(requiredFixture(from.splice(index, 1)[0]));
      if (field === "profile-role") {
        guide.references = from;
        guide.steps = to;
      } else {
        guide.steps = from;
        guide.references = to;
      }
    } else listing[field] = "https://example.invalid/unrelated";
    assert.throws(() => check(changed), /shared/, field);
  }
  const independent = structuredClone(families);
  for (const { listing } of independent) {
    listing.name += listing.id;
    listing.issue_number = (listing.issue_number ?? 1) + 10000;
    listing.download_block_reason = `An independently reviewed condition for ${listing.id}.`;
    const guide = fixtureRecord(listing.manual_setup);
    const steps = fixtureRecords(guide.steps);
    requiredFixture(steps[0]).instruction = `Original-file requirements for ${listing.id}.`;
    steps.splice(1, 0, {
      title: `Variant setup for ${listing.id}`,
      instruction: `An independent original-data choice for ${listing.id}.`,
    });
    guide.steps = steps;
  }
  check(independent);
});

void test("OpenMoHAA shares the official package without mixing edition launchers or data", () => {
  const { records } = readCatalogSource(catalogRoot);
  const family = records.filter((record) => record.openmohaa_portable_v1);
  assert.equal(family.length, 3);
  for (const [edition, additionalDirectory] of [
    ["base", undefined],
    ["spearhead", "mainta"],
    ["breakthrough", "maintt"],
  ] as const) {
    const record = requiredFixture(family.find((port) => port.openmohaa_portable_v1 === edition));
    const explicit = projectOpenMohaaPortable(record);
    const integration = fixtureRecord(explicit.integration);
    const launcher = `launch_openmohaa_${edition}`;
    assert.deepEqual(compactOpenMohaaPortable(explicit), record);
    assert.equal(projectOpenMohaaPortable(explicit), explicit);
    assert.deepEqual(projectAuthoredPort(record), projectAuthoredPort(explicit));
    assert.deepEqual(explicit.listing.original_game, record.listing.original_game);
    assert.deepEqual(explicit.listing.manual_setup, record.listing.manual_setup);
    assert.deepEqual(
      integration.persistent_paths,
      additionalDirectory ? ["main", additionalDirectory] : ["main"],
    );
    assert.deepEqual(fixtureRecord(integration.executable_hints)["windows-x86-64"], [
      `${launcher}.exe`,
    ]);
    const layouts = fixtureRecord(integration.reviewed_package_layouts);
    for (const target of ["linux-x86-64", "macos-aarch64", "macos-x86-64"]) {
      assert.deepEqual(fixtureRecord(integration.executable_hints)[target], [launcher]);
      assert.deepEqual(layouts[target], { directories: [], executables: [launcher, "openmohaa"] });
    }
    assert.deepEqual(fixtureRecord(layouts["windows-x86-64"]).executables, [
      "launch_openmohaa_base.exe",
      "launch_openmohaa_breakthrough.exe",
      "launch_openmohaa_spearhead.exe",
      "omohaaded.exe",
      "openmohaa.exe",
    ]);
    assert.equal(integration.external_profile_policy, "openmohaa-unix-v1");

    const custom = structuredClone(explicit);
    custom.integration!.persistent_paths = ["player-custom-root"];
    assert.equal(compactOpenMohaaPortable(custom), custom);
    assert.throws(
      () => checkedAuthoredPort({ ...custom, openmohaa_portable_v1: edition }),
      /supplies the package, launcher and data layout/u,
    );
  }
  const base = requiredFixture(family.find((record) => record.openmohaa_portable_v1 === "base"));
  assert.throws(
    () => checkedAuthoredPort({ ...base, openmohaa_portable_v1: "spearhead" }),
    /matching game edition/u,
  );
  assert.throws(
    () =>
      checkedAuthoredPort({ ...base, listing: { ...base.listing, platforms: ["linux-x86-64"] } }),
    /platform must be declared once/u,
  );
});

void test("ReflectionHLE authoring preserves the exact portable data paths for all configured ports", () => {
  const { records } = readCatalogSource(catalogRoot);
  const family = records.filter((record) => record.reflectionhle_portable_paths_v1);
  assert.equal(family.length, 9);
  for (const record of family) {
    const explicit = projectReflectionHlePortablePaths(record);
    delete explicit.reflectionhle_portable_paths_v1;
    const projected = requiredFixture(projectAuthoredPort(record));
    const fromCatalog = requiredFixture(
      fixtureRecords(schema3Fixture.ports).find((port) => port.id === record.listing.id),
    );
    assert.deepEqual(projected, fromCatalog);
    assert.ok(Array.isArray(projected.persistent_paths));
    const persistentPaths: unknown[] = projected.persistent_paths;
    assert.equal(persistentPaths.length, 110);
    assert.deepEqual(compactReflectionHlePortablePaths(explicit), record);

    const alternate = structuredClone(explicit);
    alternate.integration!.persistent_paths = [...persistentPaths, "custom.cfg"];
    assert.equal(compactReflectionHlePortablePaths(alternate), alternate);
    alternate.reflectionhle_portable_paths_v1 = true;
    assert.throws(() => checkedAuthoredPort(alternate), /already own persistent_paths/u);
  }
  const nested = structuredClone(requiredFixture(family[0]));
  nested.integration!.runtime_subdirectory = "alternate";
  assert.throws(() => checkedAuthoredPort(nested), /reviewed portable root layout/u);
});

void test("per-port source projects all accepted operations unchanged and listing-only records stay inert", () => {
  const source = readCatalogSource(catalogRoot);
  const accepted = fixtureJson(readFileSync(join(catalogRoot, "catalog.json")));
  assert.deepEqual(source.catalog, accepted);
  const listing = checkedAuthoredPort({
    format_version: 1,
    listing: {
      id: "source-only-fixture",
      name: "Source-only fixture",
      summary: "An identified upstream project.",
      project_url: "https://example.org/source-only",
      availability: "source-only",
    },
  });
  const shared = fixtureJson(readFileSync(join(catalogRoot, "catalog-shared.json")));
  const projected = assembleCatalogRecords(shared, [...source.records, listing]);
  assert.deepEqual(projected.catalog, source.catalog);
  assert.equal(projected.directory.listings.length, source.directory.listings.length + 1);
  assert.deepEqual(
    projected.directory.listings.find((port) => port.id === listing.listing.id)?.platforms,
    [],
  );
  assert.throws(
    () => assembleCatalogRecords(shared, [listing, listing]),
    /duplicate stable listing IDs/,
  );
  assert.throws(() => checkedAuthoredPort(listing, "wrong-file"), /filename and stable listing ID/);
  assert.throws(
    () => checkedAuthoredPort({ ...listing, integration: { id: listing.listing.id } }),
    /second integration authority/,
  );
});

void test("upstream package platforms extend only the descriptive listing", () => {
  const { records, catalog, directory } = readCatalogSource(catalogRoot);
  const id = "body-harvest-recompiled";
  assert.deepEqual(catalog.ports.find((port) => port.id === id)?.platforms, [
    "windows-x86-64",
    "linux-x86-64",
  ]);
  assert.deepEqual(directory.listings.find((port) => port.id === id)?.platforms, [
    "windows-x86-64",
    "linux-x86-64",
    "macos-x86-64",
    "macos-aarch64",
  ]);
  const duplicate = structuredClone(records.find((record) => record.listing.id === id)!);
  duplicate.listing.platforms = ["windows-x86-64"];
  assert.throws(() => checkedAuthoredPort(duplicate), /platform must be declared once/);
});

void test("managed setup can use a guide distinct from the upstream listing", () => {
  const { records, catalog, directory } = readCatalogSource(catalogRoot);
  const id = "alexbeav-diablo-recomp";
  const record = records.find((port) => port.listing.id === id)!;
  const managed = catalog.ports.find((port) => port.id === id)?.presentation;
  const listing = directory.listings.find((port) => port.id === id);
  assert.match(JSON.stringify(managed?.manual_setup), /then builds the game on this computer/);
  assert.match(JSON.stringify(listing?.manual_setup), /Choose the official Mac ZIP/);
  const integration = { ...record.integration, presentation: {} };
  const inherited = projectAuthoredPort(checkedAuthoredPort({ ...record, integration }));
  assert.deepEqual(inherited?.presentation?.manual_setup, record.listing.manual_setup);
  assert.throws(
    () =>
      checkedAuthoredPort({
        ...record,
        integration: { ...integration, presentation: { manual_setup: { steps: [] } } },
      }),
    /integration\.presentation\.manual_setup requires steps and warnings arrays/,
  );
});

void test("authored JSON refuses duplicate decoded keys while retaining nested data and native grammar", () => {
  assert.throws(() => parseCatalogSource('{"id":"first","id":"second"}'), /duplicate JSON key/);
  assert.throws(
    () => parseCatalogSource('{"id":"first","\\u0069d":"second"}'),
    /duplicate JSON key/,
  );
  assert.throws(() => parseCatalogSource('{"nested":[{"x":1,"x":2}]}'), /duplicate JSON key/);
  assert.throws(() => parseCatalogSource('{"id":"first",}'), SyntaxError);
  const valid =
    '{"nested":[{"id":"first"},{"id":"second"}],"literal":"{\\\"id\\\":\\\"a\\\"}","__proto__":{"id":"own"}}';
  assert.deepEqual(parseCatalogSource(valid), JSON.parse(valid));
});

void test("download restrictions project through the versioned directory without managed authority", () => {
  const source = readCatalogSource(catalogRoot);
  const shared = fixtureJson(readFileSync(join(catalogRoot, "catalog-shared.json")));
  const record = checkedAuthoredPort({
    format_version: 1,
    listing: {
      id: "restricted-fixture",
      name: "Restricted fixture",
      summary: "An upstream project.",
      project_url: "https://example.org/project",
      download_block_reason: "Resolve the exact upstream permission.",
    },
  });
  const projection = assembleCatalogRecords(shared, [record]);
  assert.equal(projection.directory.format_version, 2);
  assert.equal(
    projection.directory.listings[0]?.download_block_reason,
    record.listing.download_block_reason,
  );
  assert.equal(projection.catalog.ports.length, 0);
  assert.throws(
    () => checkedAuthoredPort({ ...record, integration: { adapter: "native-portable" } }),
    /download restriction cannot coexist with a managed integration/,
  );
  const prepared = source.records.find((candidate) => candidate.listing.id === "dkc2-recomp");
  assert.ok(prepared);
  const preparedWithHold = checkedAuthoredPort({
    ...prepared,
    listing: { ...prepared.listing, download_block_reason: record.listing.download_block_reason },
  });
  const preparedWithoutHold = structuredClone(preparedWithHold);
  delete preparedWithoutHold.listing.download_block_reason;
  const heldPrepared = assembleCatalogRecords(shared, [preparedWithHold]);
  const unheldPrepared = assembleCatalogRecords(shared, [preparedWithoutHold]);
  assert.equal(
    heldPrepared.directory.listings[0]?.download_block_reason,
    record.listing.download_block_reason,
  );
  assert.deepEqual(heldPrepared.catalog.ports, unheldPrepared.catalog.ports);
  assert.partialDeepStrictEqual(heldPrepared.catalog.ports[0], {
    release: { provider: "user-prepared" },
  });
  const legacy = structuredClone(record);
  delete legacy.listing.download_block_reason;
  assert.equal(assembleCatalogRecords(shared, [legacy]).directory.format_version, 1);
  for (const reason of ["", " trailing ", "line\nbreak", "x".repeat(4097), { allowed: true }]) {
    assert.throws(
      () =>
        checkedAuthoredPort({
          ...record,
          listing: { ...record.listing, download_block_reason: reason },
        }),
      /download restriction/,
    );
  }
  assert.ok(source.records.length > 0);
});

void test("authoring split preserves unknown metadata and ordered operational arrays", () => {
  const original = fixtureJson(readFileSync(join(catalogRoot, "catalog.json")));
  const catalog = fixtureCatalog(original);
  const port = structuredClone(requiredFixture(catalog.ports[0]));
  port.unfamiliar_metadata = { retained: ["second", "first"] };
  port.launch_arguments = ["--second", "--first"];
  const authored = authoringRecordFromPort(port, 0);
  const shared: Record<string, unknown> = { ...catalog };
  delete shared.ports;
  const projected = assembleCatalogRecords(shared, [authored]);
  assert.deepEqual(projected.catalog.ports[0], port);
  assert.equal(Object.hasOwn(authored.integration ?? {}, "name"), false);
  assert.equal(Object.hasOwn(authored.integration?.presentation ?? {}, "artwork"), false);
});

void test("inherits only reviewed descriptive selectors for the same package scope", () => {
  const shared = fixtureJson(readFileSync(join(catalogRoot, "catalog-shared.json")));
  const record = checkedAuthoredPort(
    fixtureJson(readFileSync(join(catalogRoot, "ports", "alariq-mc2.json"))),
  );
  const platform = "windows-x86-64";
  const integrated = assembleCatalogRecords(shared, [record]);
  assert.deepEqual(integrated.directory.listings[0]?.download_asset_hints, {
    [platform]: ["mc2-win64-", ".zip"],
  });
  const literal = structuredClone(record);
  delete literal.listing_inherit_asset_hints;
  literal.listing.download_asset_hints = { [platform]: ["mc2-win64-", ".zip"] };
  assert.deepEqual(assembleCatalogRecords(shared, [literal]).directory, integrated.directory);
  const override = structuredClone(record);
  override.listing.download_asset_hints = { [platform]: ["other-reviewed.zip"] };
  assert.deepEqual(
    assembleCatalogRecords(shared, [override]).directory.listings[0]?.download_asset_hints,
    {
      [platform]: ["other-reviewed.zip"],
    },
  );
  const suppressed = structuredClone(record);
  suppressed.listing.download_asset_hints = {};
  assert.deepEqual(
    assembleCatalogRecords(shared, [suppressed]).directory.listings[0]?.download_asset_hints,
    {},
  );
  const broader = structuredClone(record);
  broader.listing.platforms = ["linux-x86-64"];
  broader.listing.download_asset_hints = { "linux-x86-64": ["linux-package.tar.gz"] };
  const projection = assembleCatalogRecords(shared, [broader]);
  assert.deepEqual(projection.directory.listings[0]?.download_asset_hints, {
    "linux-x86-64": ["linux-package.tar.gz"],
    [platform]: ["mc2-win64-", ".zip"],
  });
  assert.deepEqual(projection.catalog, integrated.catalog);
  const fork = structuredClone(record);
  fork.listing.release_url = "https://github.com/fork/mc2/releases";
  const differentTag = structuredClone(record);
  differentTag.listing.release_url = "https://github.com/alariq/mc2/releases/tag/v1";
  const wrongPlatform = structuredClone(record);
  wrongPlatform.listing_inherit_asset_hints = ["linux-x86-64"];
  for (const invalid of [fork, differentTag, wrongPlatform])
    assert.throws(() => assembleCatalogRecords(shared, [invalid]), /same-project GitHub/);
});

void test("listing download hints remain advisory and reject ambiguous authoring shapes", () => {
  const shared = fixtureJson(readFileSync(join(catalogRoot, "catalog-shared.json")));
  const listing = {
    id: "setup-fixture",
    name: "Setup fixture",
    summary: "An upstream setup handoff.",
    project_url: "https://example.org/game",
    download_asset_hints: { "windows-x86-64": ["-Windows_Installer.exe"] },
    recommended_download_channel: "beta",
  };
  const record = checkedAuthoredPort({ format_version: 1, listing });
  const projection = assembleCatalogRecords(shared, [record]);
  assert.deepEqual(
    projection.directory.listings[0]?.download_asset_hints,
    listing.download_asset_hints,
  );
  assert.equal(projection.catalog.ports.length, 0);
  assert.equal(projection.directory.listings[0]?.recommended_download_channel, "beta");
  for (const channel of ["rolling", "nightly", 1, null]) {
    assert.throws(
      () =>
        checkedAuthoredPort({
          format_version: 1,
          listing: { ...listing, recommended_download_channel: channel },
        }),
      /recommended download channel/,
    );
  }
  for (const hints of [
    [],
    { unknown: ["game.zip"] },
    { "windows-x86-64": [] },
    { "windows-x86-64": ["same", "SAME"] },
    { "windows-x86-64": [" trailing "] },
    { "windows-x86-64": ["bad\nname"] },
    { "windows-x86-64": ["x".repeat(161)] },
  ]) {
    assert.throws(
      () =>
        checkedAuthoredPort({
          format_version: 1,
          listing: { ...listing, download_asset_hints: hints },
        }),
      /download asset hints/,
    );
  }
});

void test("original game identity projects exact authored groups and multiple source editions without operational authority", () => {
  const source = readCatalogSource(catalogRoot);
  const shared = fixtureJson(readFileSync(join(catalogRoot, "catalog-shared.json")));
  const original_game = {
    format_version: 1,
    id: "example-game",
    evidence_urls: ["https://example.com/game"],
    source_editions: [
      {
        id: "example-console",
        title: "Console edition",
        system: "nintendo-64",
        evidence_urls: ["https://example.com/console"],
      },
      {
        id: "example-computer",
        title: "Computer edition",
        system: "pc",
        evidence_urls: ["https://example.com/computer"],
      },
    ],
  };
  const base = {
    format_version: 1,
    listing: {
      id: "edition-fixture",
      name: "Example port",
      summary: "Descriptive metadata only.",
      project_url: "https://example.com/port",
      original_game,
    },
  };
  const record = checkedAuthoredPort(base);
  const projected = assembleCatalogRecords(shared, [...source.records, record]);
  // The real source carries implementation descriptions (format 12); the date-free record alone stays 3.
  assert.equal(projected.directory.format_version, 12);
  assert.equal(assembleCatalogRecords(shared, [record]).directory.format_version, 3);
  assert.deepEqual(projected.catalog, source.catalog);
  assert.deepEqual(
    projected.directory.listings.find((value) => value.id === "edition-fixture")?.original_game,
    original_game,
  );
  const integrated = source.records.find((value) => value.integration)!;
  const withMetadata = checkedAuthoredPort({
    ...integrated,
    listing: { ...integrated.listing, original_game },
  });
  const assembled = assembleCatalogRecords(shared, [withMetadata]);
  assert.deepEqual(assembled.catalog.ports[0]?.presentation?.original_game, original_game);
  assert.deepEqual(
    authoringRecordFromPort(assembled.catalog.ports[0]).listing.original_game,
    original_game,
  );
  for (const invalid of [
    { ...original_game, format_version: 2 },
    { ...original_game, id: "Ambiguous title" },
    { ...original_game, evidence_urls: [] },
    { ...original_game, evidence_urls: ["http://example.com/source"] },
    {
      ...original_game,
      source_editions: [original_game.source_editions[0], original_game.source_editions[0]],
    },
    {
      ...original_game,
      source_editions: [{ ...original_game.source_editions[0], system: "Nintendo 64" }],
    },
    { ...original_game, unexpected: true },
  ])
    assert.throws(() =>
      checkedAuthoredPort({ ...base, listing: { ...base.listing, original_game: invalid } }),
    );
  assert.doesNotThrow(() =>
    checkedAuthoredPort({
      ...base,
      listing: { ...base.listing, original_game: { ...original_game, source_editions: [] } },
    }),
  );
});

void test("descriptive media projects to format 3 and explicit empty strict media remains a removal", () => {
  const source = readCatalogSource(catalogRoot);
  const shared = fixtureJson(readFileSync(join(catalogRoot, "catalog-shared.json")));
  const media = [
    {
      id: "upstream-screenshot",
      role: "screenshot",
      subject: { kind: "port", port_id: "media-fixture" },
      caption: "A synthetic screenshot fixture.",
      url: "https://raw.githubusercontent.com/example/media/" + "a".repeat(40) + "/screen.png",
      sha256: "b".repeat(64),
      width: 640,
      height: 480,
      attribution: "Fixture author",
      source_url: "https://example.com/media",
      license: "CC0-1.0",
      rights_url: "https://example.com/rights",
    },
  ];
  const record = checkedAuthoredPort({
    format_version: 1,
    listing: {
      id: "media-fixture",
      name: "Media fixture",
      summary: "No managed integration.",
      project_url: "https://example.com/port",
      media,
    },
  });
  const projected = assembleCatalogRecords(shared, [record]);
  assert.equal(projected.directory.format_version, 3);
  assert.deepEqual(projected.directory.listings[0]?.media, media);
  assert.equal(projected.catalog.ports.length, 0);
  // New optional fields survive the JS writer verbatim, including explicit null.
  // Their presence therefore requires format5 even when the semantic value is unknown.
  for (const optional of [
    { edition_neutral: null },
    { edition_neutral: false },
    { edition_neutral: true },
    { igdb: null },
  ]) {
    const extended = checkedAuthoredPort({
      ...record,
      listing: { ...record.listing, media: [{ ...media[0], ...optional }] },
    });
    const emitted = fixtureJson(
      JSON.stringify(assembleCatalogRecords(shared, [extended]).directory),
    );
    assert.equal(emitted.format_version, 5);
    const emittedListing = requiredFixture(fixtureRecords(emitted.listings)[0]);
    assert.deepEqual(fixtureRecords(emittedListing.media)[0], { ...media[0], ...optional });
  }
  const integrated = source.records.find((value) => value.integration)!;
  const removal = checkedAuthoredPort({
    ...integrated,
    listing: { ...integrated.listing, media: [] },
  });
  const removed = assembleCatalogRecords(shared, [removal]);
  assert.deepEqual(removed.catalog.ports[0]?.presentation?.media, []);
  assert.deepEqual(authoringRecordFromPort(removed.catalog.ports[0]).listing.media, []);
});

void test("optional recommendation observations round-trip as inert presentation without changing the operational route", () => {
  const source = readCatalogSource(catalogRoot);
  const original = source.catalog.ports.find((port) => port.id === "fragglet-sdl-sopwith")!;
  for (const optional of [
    { format_version: 1, observations: [], capabilities: [] },
    { format_version: 999, future_observations: ["preserve without interpretation"] },
    { malformed: "optional interpretation must fail without hiding the ordinary project" },
  ]) {
    const port = structuredClone(original);
    port.presentation = { ...fixtureRecord(port.presentation), recommendation: optional };
    const record = authoringRecordFromPort(port);
    const assembled = assembleCatalogRecords(
      fixtureJson(readFileSync(join(catalogRoot, "catalog-shared.json"))),
      [record],
    );
    assert.deepEqual(assembled.catalog.ports[0], port);
    assert.deepEqual(assembled.catalog.ports[0].release, original.release);
    assert.deepEqual(assembled.catalog.ports[0].adapter, original.adapter);
  }
});

void test("reference guides select strict new formats and retain actions and warnings", () => {
  const source = readCatalogSource(catalogRoot);
  assert.equal(source.catalog.schema_version, 3);
  assert.equal(source.directory.format_version, 12);
  const syphon = source.directory.listings.find(
    (listing) => listing.id === "syphon-filter-sf-pc-port",
  );
  const guide = fixtureRecord(syphon?.manual_setup);
  assert.deepEqual(
    fixtureRecords(guide.steps).map((step) => step.title),
    [
      "Download the Windows port",
      "Keep your original disc files together",
      "Add the program to Portcove",
      "Choose Play",
    ],
  );
  assert.ok(
    fixtureRecords(guide.references).some((section) =>
      String(section.instruction).includes("historical observation"),
    ),
  );
  assert.ok(
    (guide.warnings as string[]).some((text) => text.includes("will not back up or update")),
  );
  const render96 = source.catalog.ports.find((port) => port.id === "render96ex");
  const renderGuide = fixtureRecord(fixtureRecord(render96?.presentation).manual_setup);
  assert.equal(fixtureRecords(renderGuide.steps).length, 2);
  assert.ok(
    (renderGuide.warnings as string[]).some((text) =>
      text.includes("Separate program folders can share saves"),
    ),
  );
});

// Optional descriptive advice stays separate from operational authoring.
{
  const platforms = ["windows-x86-64"];
  const record = {
    id: "manual-runtime",
    feature: "updates",
    platform: platforms[0],
    route: "existing-copy",
    explanation: "Follow upstream instructions for updating this copy.",
    provenance: "https://example.com/fixture",
    observed_at: 1,
    evidence: "manual-requirement",
  };
  const envelope = { format_version: 1, records: [record] };

  await test("broad manual requirements need no invented artifact identity", () => {
    checkCatalogAdvisories(envelope, platforms, 2);
    checkedAuthoredPort({
      format_version: 1,
      listing: {
        id: "fixture",
        name: "Fixture",
        summary: "Fixture project",
        project_url: "https://example.com/fixture",
        compatibility: envelope,
      },
    });
  });

  await test("launch behavior requires a scoped format-2 package and both launch stages", () => {
    const launch = {
      ...record,
      feature: "launch",
      route: "upstream-setup",
      evidence: "upstream-reported",
      release: "v1",
      artifact_sha256: "a".repeat(64),
      launch_behavior: {
        first_launch: "asks-for-game-files",
        repeat_launch: "starts-game-directly",
      },
    };
    const valid = { format_version: 2, records: [launch] };
    checkCatalogAdvisories(valid, platforms, 2);
    for (const unscoped of [
      { ...valid, format_version: 1 },
      { ...valid, records: [{ ...launch, artifact_sha256: null }] },
      { ...valid, records: [{ ...launch, release: null }] },
      { ...valid, records: [{ ...launch, launch_behavior: { first_launch: "unknown" } }] },
      { ...valid, records: [{ ...launch, route: ["managed"] }] },
      { ...valid, records: [{ ...launch, evidence: ["observed"] }] },
      {
        ...valid,
        records: [
          {
            ...launch,
            launch_behavior: { ...launch.launch_behavior, first_launch: ["unknown"] },
          },
        ],
      },
    ]) {
      assert.throws(() => checkCatalogAdvisories(unscoped, platforms, 2));
    }
  });

  await test("authoring refuses future, malformed, duplicate, unsafe and unscoped advisory content", () => {
    for (const value of [
      { ...envelope, format_version: 2 },
      { ...envelope, grants: true },
      { ...envelope, records: [record, record] },
      ...[
        { command: "run" },
        { feature: "grant" },
        { route: "any" },
        { observed_at: 3 },
        { artifact_sha256: "a".repeat(64) },
        { workaround: "Run `sh setup`" },
        { workaround: "Open /home/player/game" },
        { provenance: "https://user:secret@example.com" },
      ].map((delta) => ({ ...envelope, records: [{ ...record, ...delta }] })),
    ])
      assert.throws(() => checkCatalogAdvisories(value, platforms, 2));
  });
}

void test("GitLab descriptive observations derive listing format8 without changing operational output", () => {
  const accepted = readCatalogSource(catalogRoot);
  const records = structuredClone(accepted.records);
  const record = records.find(
    (entry) => entry.listing.project_url === "https://gitlab.com/sonicdcer/MarioKart64Recomp",
  );
  assert.ok(record);
  record.listing.upstream_observation = {
    provider: "gitlab",
    repository: "sonicdcer/MarioKart64Recomp",
    repository_id: null,
    status: "failed",
    attempted_at: "2026-11-04T00:00:00Z",
    observed_at: null,
    fresh_until: null,
    facts_sha256: null,
    release_limit: 4,
    releases: [],
  };
  const { ports: _ports, ...shared } = accepted.catalog;
  const assembled = assembleCatalogRecords(shared, records);
  // GitLab observations need 8; implementation descriptions lift the real directory to 12.
  assert.equal(assembled.directory.format_version, 12);
  assert.deepEqual(assembled.catalog, accepted.catalog);
  const compatibility = {
    format_version: 1,
    records: [
      {
        id: "manual-updates",
        feature: "updates",
        platform: "windows-x86-64",
        route: "existing-copy",
        explanation: "Follow upstream update instructions.",
        provenance: "https://gitlab.com/sonicdcer/MarioKart64Recomp",
        observed_at: 1,
        evidence: "manual-requirement",
      },
    ],
  };
  record.listing.compatibility = compatibility;
  const combined = assembleCatalogRecords(shared, records);
  assert.equal(combined.directory.format_version, 12);
  assert.deepEqual(
    combined.directory.listings.find((listing) => listing.id === record.listing.id)?.compatibility,
    compatibility,
  );
  assert.deepEqual(combined.catalog, accepted.catalog);
});

void test("catalog player copy catches engineering handoffs and preserves technical references", () => {
  const fixture = {
    format_version: 1,
    listing: {
      id: "prose-fixture",
      name: "Game port",
      project_url: "https://example.org/port",
      summary: "Set up this port with your original game files.",
      manual_setup: {
        steps: [
          {
            title: "Choose the game program",
            instruction: "Choose player.exe and keep firmware.bin beside it.",
          },
        ],
        warnings: ["Back up save.old1 before opening the game."],
        references: [
          {
            title: "Technical details",
            instruction: "The runtime writes an execution intent to the developer log.",
          },
        ],
      },
    },
  };
  assert.doesNotThrow(() => checkedAuthoredPort(fixture));
  for (const field of ["summary", "instruction", "warning"] as const) {
    const bad = structuredClone(fixture);
    const text = "Review this execution intent before continuing.";
    if (field === "summary") bad.listing.summary = text;
    else if (field === "instruction") bad.listing.manual_setup.steps[0]!.instruction = text;
    else bad.listing.manual_setup.warnings[0] = text;
    assert.throws(() => checkedAuthoredPort(bad), /prose-fixture.*execution intent/i);
  }
});

void test("authored setup guides require the arrays consumed by Core", () => {
  const steps = [{ title: "Install the framework", instruction: "Use the upstream package." }];
  const authored = (manual_setup: unknown) => ({
    format_version: 1,
    listing: {
      id: "setup-fixture",
      name: "Game port",
      project_url: "https://example.org/port",
      summary: "Prepare your copy.",
      manual_setup,
    },
  });
  for (const guide of [{ steps }, { warnings: [] }, { steps, warnings: "" }])
    assert.throws(() => checkedAuthoredPort(authored(guide)), /requires steps and warnings arrays/);
  const guide = { steps, warnings: [], help_url: "https://example.org/setup" };
  assert.deepEqual(checkedAuthoredPort(authored(guide)).listing.manual_setup, guide);
  assert.throws(
    () =>
      checkedAuthoredPort(
        authored({
          ...guide,
          references: [{ title: "Upstream reference", url: "https://example.org/unsupported" }],
        }),
      ),
    /setup-fixture listing.manual_setup.references\[0\].*unknown field: "url"/,
  );
  assert.throws(
    () => checkedAuthoredPort(authored({ ...guide, "": true })),
    /setup-fixture listing.manual_setup.*unknown field: ""/,
  );
  assert.throws(
    () => checkedAuthoredPort(authored({ ...guide, steps: [{ ...steps[0], "": true }] })),
    /setup-fixture listing.manual_setup.steps\[0\].*unknown field: ""/,
  );
  assert.throws(
    () => checkedAuthoredPort(authored({ ...guide, steps: [{ title: "Use the upstream guide" }] })),
    /setup-fixture listing.manual_setup.steps\[0\].*requires a title and instruction/,
  );
});

void test("Second Hunt keeps its version-scoped cleanup warning in the pre-action warnings", () => {
  const source = readCatalogSource(catalogRoot);
  const listing = source.directory.listings.find(
    (entry) => entry.id === "bountyhunterkanden-secondhunt",
  );
  const guide = fixtureRecord(listing?.manual_setup);
  const warnings = guide.warnings;
  assert.ok(Array.isArray(warnings));
  assert.match(String(warnings[0]), /Before opening Second Hunt v0\.4\.2-beta on Windows/);
  assert.match(String(warnings[0]), /ending in \.old or \.old followed by digits/);
  assert.match(String(warnings[0]), /outside its entire program folder.*including portable saves/);
});

void test("reviewed GBA archive facts preserve both installed contract variants", () => {
  const accepted = new Map(fixtureRecords(schema3Fixture.ports).map((port) => [port.id, port]));
  for (const id of [
    "mstan-dragonballzbuusfuryrecomp",
    "mstan-dragonballzlegacyofgokuiirecomp",
    "mstan-megamanzerorecomp",
    "mstan-supermarioadvance2recomp",
    "mstan-supermarioadvance4recomp",
    "mstan-wariowaretwistedrecomp",
  ]) {
    const record = checkedAuthoredPort(
      JSON.parse(readFileSync(join(catalogRoot, "ports", `${id}.json`), "utf8")),
    );
    assert.ok(record.gba_staged_archive_v1);
    assert.equal(JSON.stringify(projectAuthoredPort(record)), JSON.stringify(accepted.get(id)));
    for (const field of ["persistent_paths", "runtime_mutable_paths", "mod_package_policy"]) {
      const duplicate = structuredClone(record);
      duplicate.integration![field] = [];
      assert.throws(() => checkedAuthoredPort(duplicate), /already own/u);
    }
    const unsafe = structuredClone(record);
    unsafe.gba_staged_archive_v1!.game_code = "../X";
    assert.throws(() => checkedAuthoredPort(unsafe), /reviewed Windows staged GitHub archive/u);
  }
});

void test("PSX managed Windows authoring preserves the embedded contracts", () => {
  const accepted = new Map(fixtureRecords(schema3Fixture.ports).map((port) => [port.id, port]));
  const { records } = readCatalogSource(catalogRoot);
  const consumers = records.filter(
    (record) =>
      record.psx_managed_windows_v1 && record.psx_managed_windows_v1 !== "technically-computers",
  );
  assert.ok(consumers.length > 0);
  for (const record of consumers) {
    const id = record.listing.id;
    const projected = projectAuthoredPort(record);
    assert.ok(projected);
    assert.equal(JSON.stringify(projected), JSON.stringify(accepted.get(id)), id);
    if (record.psx_managed_windows_v1 === "bundled-openbios") {
      assert.deepEqual(projected.launch_arguments, [
        "--no-launcher",
        "--bios",
        "bios/openbios.bin",
      ]);
      assert.equal(Object.hasOwn(projected, "bios_source_profile"), false);
      const conflictingBios = structuredClone(record);
      conflictingBios.integration!.bios_source_profile = "psx-scph-1001-bios";
      assert.throws(() => checkedAuthoredPort(conflictingBios), /without a retail profile/u);
    }
    const duplicate = structuredClone(record);
    duplicate.integration!.runtime_subdirectory = "setup-host";
    assert.throws(() => checkedAuthoredPort(duplicate), /already owns runtime_subdirectory/u);
    const otherBios = structuredClone(record);
    otherBios.integration!.bios_source_profile = "psx-scph-5501-bios";
    assert.throws(() => checkedAuthoredPort(otherBios), /retail SCPH-1001/u);
    const otherPlatform = structuredClone(record);
    delete otherPlatform.listing.platforms;
    otherPlatform.integration!.platforms = ["macos-aarch64"];
    assert.throws(() => checkedAuthoredPort(otherPlatform), /reviewed Windows GitHub kit/u);
    const otherPlayer = structuredClone(record);
    otherPlayer.integration!.executable_hints = {
      ...(otherPlayer.integration!.executable_hints as Record<string, string[]>),
      "linux-x86-64": ["setup-host"],
    };
    assert.throws(() => checkedAuthoredPort(otherPlayer), /same generated player basename/u);
    const missingSelector = structuredClone(record);
    const release = missingSelector.integration!.release as {
      asset_hints: Record<string, string[]>;
    };
    delete release.asset_hints["linux-x86-64"];
    assert.throws(() => checkedAuthoredPort(missingSelector), /explicit asset selector/u);
  }
});

void test("TechnicallyComputers PSX persistence preserves the reviewed three-platform definitions", () => {
  const { records } = readCatalogSource(catalogRoot);
  const accepted = new Map(fixtureRecords(schema3Fixture.ports).map((port) => [port.id, port]));
  const family = records.filter(
    (record) => record.psx_managed_windows_v1 === "technically-computers",
  );
  assert.equal(family.length, 10);
  for (const record of family) {
    assert.equal(
      JSON.stringify(projectAuthoredPort(record)),
      JSON.stringify(accepted.get(record.listing.id)),
    );
    const explicit = projectPsxManagedWindows(record);
    assert.deepEqual(explicit.integration?.persistent_paths, [
      "saves",
      "config",
      "mods",
      "settings.toml",
      "game_options.json",
      "graphics.json",
      "input.json",
      "sound.json",
    ]);
    assert.equal(explicit.integration?.runtime_subdirectory, "build-portcove");
  }
  const conflict = structuredClone(requiredFixture(family[0]));
  conflict.integration!.runtime_subdirectory = "different-root";
  assert.throws(() => checkedAuthoredPort(conflict), /already owns the runtime root/u);
  const incorrectRoute = structuredClone(requiredFixture(family[0]));
  incorrectRoute.integration!.platforms = ["windows-x86-64"];
  delete incorrectRoute.managed_setup_platform_warnings;
  assert.throws(() => checkedAuthoredPort(incorrectRoute), /reviewed Windows and macOS/u);
  const tomba = requiredFixture(records.find(({ listing }) => listing.id === "tomba-recompiled"));
  assert.equal(tomba.psx_managed_windows_v1, undefined);
  assert.equal(compactPsxManagedWindows(tomba), tomba);
});

void test("PSX preparation compacts exact layouts and retains explicit writer differences", () => {
  const { records } = readCatalogSource(catalogRoot);
  for (const record of records.filter((entry) => entry.psx_managed_windows_v1 !== undefined)) {
    const explicit = projectPsxManagedWindows(record);
    delete explicit.psx_managed_windows_v1;
    const compact = compactPsxManagedWindows(explicit);
    assert.deepEqual(compact, record, record.listing.id);
    assert.equal(
      JSON.stringify(projectAuthoredPort(compact)),
      JSON.stringify(projectAuthoredPort(explicit)),
    );

    const custom = structuredClone(explicit);
    custom.integration!.persistent_paths = ["custom-save"];
    assert.equal(compactPsxManagedWindows(custom), custom);
  }
});

void test("PSX retail split-mods preparation preserves the reviewed multidisc contract", () => {
  const { records } = readCatalogSource(catalogRoot);
  const source = records.find(
    (record) => record.listing.id === "alexbeav-alone-in-the-dark-the-new-nightmare-recomp",
  );
  assert.ok(source);
  const explicit = projectPsxManagedWindows(structuredClone(source));
  delete explicit.psx_managed_windows_v1;
  const compact = compactPsxManagedWindows(explicit);
  assert.equal(compact.psx_managed_windows_v1, "split-mods");
  assert.equal(compact.integration?.runtime_source_filename, "runtime-discs");
  assert.equal(compact.integration?.runtime_source_materialization, "psx-raw-set");
  assert.equal(compact.integration?.launch_disc_choice, "psx-settings-selected");
  assert.equal(
    JSON.stringify(projectAuthoredPort(compact)),
    JSON.stringify(projectAuthoredPort(explicit)),
  );

  const incomplete = structuredClone(compact);
  delete incomplete.integration!.launch_disc_choice;
  assert.throws(() => projectPsxManagedWindows(incomplete), /multidisc/u);
  const different = structuredClone(explicit);
  different.integration!.runtime_source_filename = "other-discs";
  assert.equal(compactPsxManagedWindows(different), different);
});

void test("PSX split mods keep the reviewed overlay directory layout distinct", () => {
  const { records } = readCatalogSource(catalogRoot);
  const record = records.find((entry) => entry.listing.id === "alexbeav-alundra-recomp");
  assert.ok(record);
  assert.equal(record.psx_managed_windows_v1, "split-mods-overlay-directory");
  const explicit = projectPsxManagedWindows(record);
  delete explicit.psx_managed_windows_v1;
  assert.deepEqual(explicit.integration!.persistent_paths, [
    "saves",
    "settings.toml",
    "input.ini",
    "keybinds.ini",
    "config.ini",
    "disc.cfg",
    "bios.cfg",
    "mods/installed",
    "mods/packages",
    "mods/.staging",
    "mods/state.toml",
    "mods/state.toml.tmp",
    "mods/texture-packs",
    "overlay-captures",
  ]);
  assert.deepEqual(explicit.integration!.runtime_mutable_file_patterns, [
    { prefix: "psx_freeze_dump_psx-runtime_", suffix: ".json" },
  ]);
  assert.deepEqual(compactPsxManagedWindows(explicit), record);

  const different = structuredClone(explicit);
  (different.integration!.persistent_paths as string[]).push("diagnostics-location.txt");
  assert.equal(compactPsxManagedWindows(different), different);

  const multidisc = structuredClone(record);
  Object.assign(multidisc.integration!, {
    runtime_source_filename: "runtime-discs",
    launch_disc_choice: "psx-settings-selected",
    runtime_source_materialization: "psx-raw-set",
  });
  assert.throws(() => checkedAuthoredPort(multidisc), /multidisc/u);

  const explicitException = records.find(
    (entry) => entry.listing.id === "alexbeav-medievil-recomp",
  );
  assert.ok(explicitException);
  assert.equal(explicitException.psx_managed_windows_v1, undefined);
  assert.equal(compactPsxManagedWindows(explicitException), explicitException);
});

void test("GBA preparation compacts exact layouts and retains explicit writer differences", () => {
  const { records } = readCatalogSource(catalogRoot);
  const supported = records.filter((entry) => entry.gba_staged_archive_v1 !== undefined);
  assert.ok(supported.length > 0);
  for (const record of supported) {
    const explicit = projectGbaArchive(record);
    delete explicit.gba_staged_archive_v1;
    const compact = compactGbaArchive(explicit);
    assert.deepEqual(compact, record, record.listing.id);
    assert.equal(
      JSON.stringify(projectAuthoredPort(compact)),
      JSON.stringify(projectAuthoredPort(explicit)),
    );

    const custom = structuredClone(explicit);
    custom.integration!.runtime_mutable_paths = ["recomp_coverage_XXXX.json"];
    assert.equal(compactGbaArchive(custom), custom);
  }
});

void test("N64 recomp persistence compacts exact layouts and preserves explicit differences", () => {
  const { catalog, records } = readCatalogSource(catalogRoot);
  const consumers = records.filter((entry) => entry.n64_recomp_persistence_v1);
  assert.ok(consumers.length > 0);
  for (const record of consumers) {
    const explicit = projectN64RecompPersistence(record);
    delete explicit.n64_recomp_persistence_v1;
    assert.deepEqual(compactN64RecompPersistence(explicit), record, record.listing.id);
    assert.equal(
      JSON.stringify(projectAuthoredPort(record)),
      JSON.stringify(catalog.ports.find((port) => port.id === record.listing.id)),
      record.listing.id,
    );
    const differentWrites = structuredClone(explicit);
    differentWrites.integration!.persistent_paths = ["custom-saves"];
    assert.equal(compactN64RecompPersistence(differentWrites), differentWrites);
    assert.throws(
      () => checkedAuthoredPort({ ...explicit, n64_recomp_persistence_v1: true }),
      /already own persistent_paths/u,
    );
  }

  const nested = records.find((record) => record.listing.id === "beetle-recomp")!;
  const otherProvider = records.find((record) => record.listing.id === "extreme-g-recompiled")!;
  for (const explicit of [nested, otherProvider]) {
    assert.equal(compactN64RecompPersistence(explicit), explicit);
    assert.throws(
      () => checkedAuthoredPort({ ...explicit, n64_recomp_persistence_v1: true }),
      /requires? the reviewed root-level GitHub recomp layout/u,
    );
  }

  const unsafe = structuredClone(consumers[0]!);
  unsafe.integration!.runtime_source_filename = "../alias.z64";
  assert.throws(() => checkedAuthoredPort(unsafe), /reviewed root-level GitHub recomp layout/u);
});

void test("PSX split mods retain player data with explicit dual-platform and retail BIOS facts", () => {
  const { records } = readCatalogSource(catalogRoot);
  const consumers = records.filter((record) => record.psx_managed_windows_v1 === "split-mods");
  const biosProfiles = new Set(consumers.map((record) => record.integration!.bios_source_profile));
  assert.deepEqual(
    biosProfiles,
    new Set(["psx-scph-1001-bios", "psx-scph-5552-bios", "psx-scph-5500-bios"]),
  );
  for (const record of consumers) {
    const projected = projectAuthoredPort(record);
    assert.ok(projected);
    assert.deepEqual(
      (projected.persistent_paths as string[]).filter(
        (path) => path === "mods" || path.startsWith("mods/"),
      ),
      [
        "mods/installed",
        "mods/packages",
        "mods/.staging",
        "mods/state.toml",
        "mods/state.toml.tmp",
        "mods/texture-packs",
      ],
    );
  }

  const [record] = consumers;
  assert.ok(record);
  const withoutBios = structuredClone(record);
  delete withoutBios.integration!.bios_source_profile;
  assert.throws(() => checkedAuthoredPort(withoutBios), /explicit retail SCPH-5552/u);
  const windowsOnly = structuredClone(record);
  windowsOnly.integration!.platforms = ["windows-x86-64"];
  assert.throws(() => checkedAuthoredPort(windowsOnly), /exact Windows and Linux x64/u);
  const withoutWindowsSelector = structuredClone(record);
  const release = withoutWindowsSelector.integration!.release as {
    asset_hints: Record<string, string[]>;
  };
  delete release.asset_hints["windows-x86-64"];
  assert.throws(() => checkedAuthoredPort(withoutWindowsSelector), /exact Windows and Linux x64/u);
  release.asset_hints["windows-x86-64"] = release.asset_hints["linux-x86-64"]!;
  assert.throws(() => checkedAuthoredPort(withoutWindowsSelector), /exact Windows and Linux x64/u);
  const wholeMods = structuredClone(record);
  wholeMods.integration!.persistent_paths = ["mods"];
  assert.throws(() => checkedAuthoredPort(wholeMods), /already owns persistent_paths/u);
  assert.throws(
    () => checkedAuthoredPort({ ...record, psx_managed_windows_v1: "split-mods-openbios" }),
    /without a retail profile/u,
  );
  const openBios = structuredClone(record);
  openBios.psx_managed_windows_v1 = "split-mods-openbios";
  delete openBios.integration!.bios_source_profile;
  const projected = projectAuthoredPort(openBios);
  assert.ok(projected);
  assert.deepEqual(projected.launch_arguments, ["--no-launcher", "--bios", "bios/openbios.bin"]);
  assert.equal(Object.hasOwn(projected, "bios_source_profile"), false);
  assert.deepEqual(
    (projected.persistent_paths as string[]).filter(
      (path) => path === "mods" || path.startsWith("mods/"),
    ),
    [
      "mods/installed",
      "mods/packages",
      "mods/.staging",
      "mods/state.toml",
      "mods/state.toml.tmp",
      "mods/texture-packs",
    ],
  );
  const openBiosWindowsOnly = structuredClone(openBios);
  openBiosWindowsOnly.integration!.platforms = ["windows-x86-64"];
  assert.throws(() => checkedAuthoredPort(openBiosWindowsOnly), /exact Windows and Linux x64/u);
});

void test("a first-listed date is authored per listing, validated, and selects listing format 9", () => {
  const source = readCatalogSource(catalogRoot);
  const { ports: _ports, ...shared } = source.catalog;
  const fixture = (extra: Record<string, unknown>) =>
    checkedAuthoredPort({
      format_version: 1,
      listing: {
        id: "dated-fixture",
        name: "Dated fixture",
        summary: "Descriptive metadata only.",
        project_url: "https://example.com/dated",
        ...extra,
      },
    });
  const dated = fixture({ listed_at: "2026-11-09" });
  assert.equal(dated.listing.listed_at, "2026-11-09");
  assert.equal(assembleCatalogRecords(shared, [dated]).directory.format_version, 9);
  // Without a date the directory keeps the format its other content needs.
  assert.equal(assembleCatalogRecords(shared, [fixture({})]).directory.format_version, 1);
  for (const bad of ["2026-13-01", "2026-02-30", "2026-11-09T00:00:00Z", "2026-1-9", "", 20261109])
    assert.throws(() => fixture({ listed_at: bad }), /listed_at/u, String(bad));
});

void test("the observation declaration hash ignores the first-listed date", () => {
  const listing = {
    id: "hash-fixture",
    name: "Hash fixture",
    summary: "Descriptive metadata only.",
    project_url: "https://github.com/example/hash",
  };
  // Adding a date to every listing must not invalidate retained observations.
  assert.equal(
    listingDeclarationHash(listing),
    listingDeclarationHash({ ...listing, listed_at: "2026-11-09" }),
  );
  assert.notEqual(
    listingDeclarationHash(listing),
    listingDeclarationHash({ ...listing, name: "A different declaration" }),
  );
});

void test("funding links are authored per listing, validated, and select listing format 10", () => {
  const source = readCatalogSource(catalogRoot);
  const { ports: _ports, ...shared } = source.catalog;
  const fixture = (extra: Record<string, unknown>) =>
    checkedAuthoredPort({
      format_version: 1,
      listing: {
        id: "funded-fixture",
        name: "Funded fixture",
        summary: "Descriptive metadata only.",
        project_url: "https://example.com/funded",
        listed_at: "2026-11-09",
        ...extra,
      },
    });
  const urls = ["https://github.com/sponsors/example", "https://ko-fi.com/example"];
  const funded = fixture({ funding_urls: urls });
  assert.deepEqual(funded.listing.funding_urls, urls);
  assert.equal(assembleCatalogRecords(shared, [funded]).directory.format_version, 10);
  assert.equal(assembleCatalogRecords(shared, [fixture({})]).directory.format_version, 9);
  const tooMany = Array.from({ length: 13 }, (_, index) => `https://example.com/${index}`);
  for (const bad of [
    [],
    ["http://ko-fi.com/example"],
    ["https://user:secret@example.com/support"],
    ["https://ko-fi.com/example", "https://ko-fi.com/example"],
    tooMany,
    "https://ko-fi.com/example",
  ])
    assert.throws(() => fixture({ funding_urls: bad }), /funding_urls/u, JSON.stringify(bad));
  // Adding or refreshing links must not invalidate retained observations.
  const listing = { id: "hash-fixture", name: "Hash", summary: "Hash.", project_url: urls[0] };
  assert.equal(
    listingDeclarationHash(listing),
    listingDeclarationHash({ ...listing, funding_urls: urls }),
  );
});

void test("the reviewed legacy additions fixture must stay in ascending order", async () => {
  const { reviewCompatibilityFixture } = await import("./catalog-authoring.mts");
  const legacy = { source_profiles: [{ id: "frozen-profile" }], ports: [{ id: "frozen-port" }] };
  const catalog = {
    source_catalog: { identities: [{ id: "frozen-profile" }, { id: "added-profile" }] },
    ports: [{ id: "frozen-port" }, { id: "alpha-port" }, { id: "beta-port" }],
  } as unknown as Parameters<typeof reviewCompatibilityFixture>[0];
  const fixture = (portIds: string[]) =>
    Buffer.from(JSON.stringify({ source_profile_ids: ["added-profile"], port_ids: portIds }));
  assert.equal(
    reviewCompatibilityFixture(catalog, legacy, fixture(["alpha-port", "beta-port"])).status,
    "matched",
  );
  assert.throws(
    () => reviewCompatibilityFixture(catalog, legacy, fixture(["beta-port", "alpha-port"])),
    /port_ids: keep IDs in ascending order/,
  );
});

void test("implementation descriptions project without changing source, route or release authority", () => {
  const source = readCatalogSource(catalogRoot);
  const record = structuredClone(
    source.records.find((record) => record.listing.id === "zelda64-recomp")!,
  );
  assert.equal(record.listing.implementation?.methods[0]?.kind, "static-recompilation");
  const declarationWithoutExplanation = { ...record.listing };
  delete declarationWithoutExplanation.implementation;
  assert.equal(
    listingDeclarationHash(record.listing),
    listingDeclarationHash(declarationWithoutExplanation),
  );
  const projected = projectAuthoredPort(record)!;
  const without = structuredClone(record);
  delete without.listing.implementation;
  const before = projectAuthoredPort(without)!;
  assert.deepEqual(projected.release, before.release);
  assert.deepEqual(projected.source_profile, before.source_profile);
  assert.deepEqual(projected.adapter, before.adapter);
  assert.deepEqual(projected.platforms, before.platforms);
  assert.deepEqual(record.listing.original_game, without.listing.original_game);
  assert.equal(source.directory.format_version, 12);
  const dependency = record.listing.implementation.dependencies[0]!;
  for (const invalid of [
    { ...record.listing.implementation, format_version: 999 },
    {
      ...record.listing.implementation,
      methods: [{ kind: "future-method", evidence_urls: ["https://example.com"] }],
    },
    { ...record.listing.implementation, dependencies: [{ ...dependency, confidence: "certain" }] },
    { ...record.listing.implementation, dependencies: [{ ...dependency, evidence_urls: [] }] },
    {
      ...record.listing.implementation,
      dependencies: [{ ...dependency, project_url: "javascript:alert(1)" }],
    },
  ])
    assert.throws(() =>
      checkedAuthoredPort({ ...record, listing: { ...record.listing, implementation: invalid } }),
    );
  for (const confidence of ["confirmed", "inferred", "contradicted"] as const) {
    const varied = checkedAuthoredPort({
      ...record,
      listing: {
        ...record.listing,
        implementation: {
          ...record.listing.implementation,
          dependencies: [{ ...dependency, confidence }],
        },
      },
    });
    assert.deepEqual(projectAuthoredPort(varied)!.release, before.release);
    assert.deepEqual(projectAuthoredPort(varied)!.source_profile, before.source_profile);
  }
});

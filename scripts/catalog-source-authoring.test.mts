import { checkCatalogAdvisories } from "./catalog-advisories.mts";
import {
  managedHoldFromRestrictions,
  restrictionsFromManagedHold,
} from "./catalog-acquisition-restrictions.mts";
import type { LegacyManagedHold } from "./catalog-acquisition-restrictions.mts";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
  compactReviewedFlatPackageLayout,
  projectReviewedFlatPackageLayout,
} from "./catalog-reviewed-flat-package-layout.mts";
import {
  compactN64RecompPersistence,
  projectN64RecompPersistence,
} from "./catalog-n64-recomp-persistence.mts";
import {
  compactPsxManagedWindows,
  projectPsxManagedWindows,
} from "./catalog-psx-managed-windows.mts";
import { estimateHealthRequests } from "./check-catalog-repositories.mts";
import { listingDeclarationHash } from "./listing-upstream-observation.mts";

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

void test("reviewed mod websites promote the directory without an operational definition", () => {
  const link = {
    id: "community",
    site: "nexus_mods",
    name: "Nexus Mods",
    url: "https://www.nexusmods.com/fixture",
    instructions: "Check the community page for mod requirements.",
  };
  const listing = {
    id: "unmanaged-mod-portal",
    name: "Unmanaged Mod Portal",
    summary: "A fixture for signed descriptive links.",
    project_url: "https://github.com/example/fixture",
  };
  const record = checkedAuthoredPort({
    format_version: 1,
    listing: { ...listing, mod_portals: [link] },
  });
  const assembled = assembleCatalogRecords(
    {
      schema_version: 3,
      source_catalog: {
        identities: [],
        contracts: [],
        validators: [],
        evidence: [],
        qualification: [],
      },
    },
    [record],
  );
  assert.equal(assembled.directory.format_version, 16);
  assert.deepEqual(assembled.directory.listings[0]?.mod_portals, [link]);
  assert.deepEqual(assembled.catalog.ports, []);
  assert.equal(listingDeclarationHash(listing), listingDeclarationHash(record.listing));
  for (const portals of [
    [{ ...link, authority: "inspect" }],
    [{ ...link, url: "https://example.com/fixture" }],
    [link, { ...link }],
  ]) {
    assert.throws(
      () =>
        checkedAuthoredPort({ format_version: 1, listing: { ...listing, mod_portals: portals } }),
      /mod portal/u,
    );
  }
});

void test("automatic GitHub identities require repository-bound listing format 17", () => {
  const listing = {
    id: "github-123",
    name: "Discovery fixture",
    summary: "A newly admitted upstream project.",
    project_url: "https://github.com/example/fixture",
    release_url: "https://github.com/example/fixture/releases",
  };
  const authored = checkedAuthoredPort({ format_version: 1, listing });
  const result = assembleCatalogRecords(
    {
      schema_version: 3,
      source_catalog: {
        identities: [],
        contracts: [],
        validators: [],
        evidence: [],
        qualification: [],
      },
    },
    [authored],
  );
  assert.equal(result.directory.format_version, 17);
  assert.equal(result.directory.listings[0]?.id, listing.id);
  assert.deepEqual(result.catalog.ports, []);
  assert.throws(
    () =>
      checkedAuthoredPort({
        format_version: 1,
        listing: { ...listing, release_url: "https://github.com/elsewhere/fixture/releases" },
      }),
    /repository-bound listing/u,
  );
  const oversized = `https://github.com/example/${"a".repeat(101)}`;
  assert.throws(
    () =>
      checkedAuthoredPort({
        format_version: 1,
        listing: { ...listing, project_url: oversized, release_url: `${oversized}/releases` },
      }),
    /repository-bound listing/u,
  );
  for (const [project_url, release_url] of [
    ["https://github.com/example/game.GIT", "https://github.com/example/game.git/releases"],
    ["https://github.com/example/Kart", "https://github.com/example/kart/releases"],
    ["https://github.com/example/kart", "https://github.com/example/Kart/releases"],
  ]) {
    assert.throws(
      () =>
        checkedAuthoredPort({
          format_version: 1,
          listing: { ...listing, project_url, release_url },
        }),
      /repository-bound listing/u,
    );
  }
});

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

void test("external runtime registration reproduces all reviewed CPS2Recomp routes", () => {
  const ports = fixtureCatalog(schema3Fixture).ports.filter((port) =>
    port.id.startsWith("cps2recomp-"),
  );
  assert.equal(ports.length, 12);
  for (const port of ports) {
    const authored = checkedAuthoredPort(
      fixtureJson(readFileSync(join(catalogRoot, "ports", `${port.id}.json`))),
    );
    assert.equal(authored.external_registration_v1, true);
    const release = fixtureRecord(authored.integration?.release);
    assert.equal(release.user_prepared, undefined);
    assert.deepEqual(projectAuthoredPort(authored), port);
    const integration = requiredFixture(authored.integration);
    const explicit = {
      ...authored,
      integration: { ...integration, release: port.release },
    };
    assert.throws(() => checkedAuthoredPort(explicit), /exclusively user-selected/u);
    delete explicit.external_registration_v1;
    assert.deepEqual(projectAuthoredPort(checkedAuthoredPort(explicit)), port);
    assert.throws(
      () =>
        checkedAuthoredPort({
          ...authored,
          integration: { ...integration, platforms: ["windows-x86-64", "windows-x86-64"] },
        }),
      /exclusively user-selected/u,
    );
  }
});

void test("GitHub Direct pins require the canonical release URL of the listing project", () => {
  const record = requiredFixture(
    readCatalogSource(catalogRoot).records.find((item) => item.listing.id === "marathon-aleph-one"),
  );
  const prefix = `${record.listing.project_url}/releases/download/`;
  const pin = `${prefix}release-20260930/Marathon-20260930-Win.zip`;
  for (const url of [
    "https://github.com/example/other/archive.zip",
    `${prefix}../../archive.zip`,
    `${prefix}transient/%2e%2e/release-20260930/Marathon-20260930-Win.zip`,
    `${prefix}release%2F20260930/Marathon-20260930-Win.zip`,
    `${prefix}release-20260930/nested/Marathon-20260930-Win.zip`,
    `${prefix}/Marathon-20260930-Win.zip`,
    `${prefix}release-20260930/`,
    `${pin}?download=1`,
    `${pin}#archive`,
    `${pin}?`,
    `${pin}#`,
  ]) {
    const otherPackage = structuredClone(record);
    const direct = fixtureRecord(fixtureRecord(otherPackage.integration?.release).direct);
    fixtureRecord(direct["windows-x86-64"]).url = url;
    assert.throws(
      () => checkedAuthoredPort(otherPackage),
      /GitHub Direct pin for windows-x86-64 must be a canonical release download/u,
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

void test("reviewed flat package authoring preserves ordered fingerprints and explicit exceptions", () => {
  const { records } = readCatalogSource(catalogRoot);
  const prior = new Map(fixtureRecords(schema3Fixture.ports).map((entry) => [entry.id, entry]));
  const family = records.filter((record) => record.reviewed_flat_package_layout_v1);
  assert.equal(family.length, 12);
  for (const record of family) {
    assert.equal(
      JSON.stringify(projectAuthoredPort(record)),
      JSON.stringify(prior.get(record.listing.id)),
    );
    const explicit = projectReviewedFlatPackageLayout(record);
    delete explicit.reviewed_flat_package_layout_v1;
    assert.deepEqual(compactReviewedFlatPackageLayout(explicit), record);
  }
  const selected = requiredFixture(
    family.find((record) => record.listing.id === "bvschaik-julius"),
  );
  assert.deepEqual(selected.reviewed_flat_package_layout_v1, ["linux-x86-64", "windows-x86-64"]);
  const nested = structuredClone(selected);
  nested.integration!.executable_hints = {
    "linux-x86-64": ["app/julius"],
    "windows-x86-64": ["julius.exe"],
  };
  assert.throws(
    () => checkedAuthoredPort(nested),
    /requires a managed GitHub archive with one root executable/u,
  );
  const duplicate = structuredClone(selected);
  duplicate.integration!.reviewed_package_layouts = {};
  assert.throws(() => checkedAuthoredPort(duplicate), /already owns reviewed_package_layouts/u);
  for (const id of [
    "mdk-sdl-nemo22",
    "dethrace-labs-dethrace",
    "blake-stone-aliens-of-gold-bstone",
    "bstoney-yt-mercenaries-2-decompilation",
  ]) {
    const explicit = requiredFixture(records.find((record) => record.listing.id === id));
    assert.equal(compactReviewedFlatPackageLayout(explicit), explicit, id);
  }
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
    listing.restrictions = [
      {
        id: "download",
        effect: "hold",
        operations: ["download"],
        reason: "package-facts-unresolved",
        explanation: `An independently reviewed condition for ${listing.id}.`,
      },
    ];
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
  const explanation = "Resolve the exact upstream permission.";
  const hold = {
    id: "download",
    effect: "hold",
    operations: ["download"],
    reason: "third-party-component-terms",
    explanation,
  };
  const record = checkedAuthoredPort({
    format_version: 1,
    listing: {
      id: "restricted-fixture",
      name: "Restricted fixture",
      summary: "An upstream project.",
      project_url: "https://example.org/project",
      restrictions: [hold],
    },
  });
  const projection = assembleCatalogRecords(shared, [record]);
  assert.equal(projection.directory.format_version, 15);
  // Older readers keep enforcing the derived legacy string.
  assert.equal(projection.directory.listings[0]?.download_block_reason, explanation);
  assert.deepEqual(projection.directory.listings[0]?.restrictions, [hold]);
  assert.equal(projection.catalog.ports.length, 0);
  assert.throws(
    () => checkedAuthoredPort({ ...record, integration: { adapter: "native-portable" } }),
    /download restriction cannot coexist with a managed integration/,
  );
  const prepared = source.records.find((candidate) => candidate.listing.id === "dkc2-recomp");
  assert.ok(prepared);
  const preparedWithHold = checkedAuthoredPort({
    ...prepared,
    listing: { ...prepared.listing, restrictions: [hold] },
  });
  const preparedWithoutHold = structuredClone(preparedWithHold);
  delete preparedWithoutHold.listing.restrictions;
  const heldPrepared = assembleCatalogRecords(shared, [preparedWithHold]);
  const unheldPrepared = assembleCatalogRecords(shared, [preparedWithoutHold]);
  assert.equal(heldPrepared.directory.listings[0]?.download_block_reason, explanation);
  assert.deepEqual(heldPrepared.catalog.ports, unheldPrepared.catalog.ports);
  assert.partialDeepStrictEqual(heldPrepared.catalog.ports[0], {
    release: { provider: "user-prepared" },
  });
  const legacy = structuredClone(record);
  delete legacy.listing.restrictions;
  assert.equal(assembleCatalogRecords(shared, [legacy]).directory.format_version, 1);
  // The legacy keys are derived and can no longer be authored.
  assert.throws(
    () =>
      checkedAuthoredPort({
        ...legacy,
        listing: { ...legacy.listing, download_block_reason: explanation },
      }),
    /download_block_reason/,
  );
  const withHold = (change: (restriction: Record<string, unknown>) => void, extra = {}) => {
    const restriction: Record<string, unknown> = structuredClone(hold);
    change(restriction);
    return () =>
      checkedAuthoredPort({
        ...record,
        listing: { ...record.listing, ...extra, restrictions: [restriction] },
      });
  };
  for (const [change, pattern] of [
    [(r: Record<string, unknown>) => (r.explanation = " trailing "), /player copy/],
    [(r: Record<string, unknown>) => (r.explanation = "x".repeat(4097)), /player copy/],
    [(r: Record<string, unknown>) => delete r.reason, /reason code/],
    [(r: Record<string, unknown>) => (r.reason = "legacy-unclassified"), /reason code/],
    [(r: Record<string, unknown>) => (r.operations = ["install"]), /outside the listing carrier/],
    [(r: Record<string, unknown>) => (r.operations = ["remove"]), /outside the listing carrier/],
    [(r: Record<string, unknown>) => (r.grant = true), /unknown field/],
    [(r: Record<string, unknown>) => (r.scope = {}), /omitted when whole/],
    [(r: Record<string, unknown>) => (r.scope = { edition: ["x"] }), /unknown dimension/],
    [(r: Record<string, unknown>) => (r.scope = { platforms: ["amiga"] }), /platforms/],
    [
      (r: Record<string, unknown>) =>
        (r.scope = { artifacts: [{ version: "v1", sha256: "ab".repeat(32) }] }),
      /release route/,
    ],
    [(r: Record<string, unknown>) => (r.tracking_issue = 0), /tracking issue/],
  ] as const)
    assert.throws(withHold(change), pattern);
  assert.throws(
    withHold((r) => (r.scope = { artifacts: [{ version: "v1", sha256: "AB".repeat(32) }] }), {
      release_url: "https://example.org/project/releases",
    }),
    /lowercase SHA-256/,
  );
  const permit = {
    id: "reviewed",
    effect: "permit",
    operations: ["download"],
    scope: { artifacts: [{ version: "v1", sha256: "ab".repeat(32), asset_name: "game.zip" }] },
  };
  const scoped = checkedAuthoredPort({
    ...record,
    listing: {
      ...record.listing,
      release_url: "https://example.org/project/releases",
      restrictions: [hold, permit],
    },
  });
  assert.equal(
    assembleCatalogRecords(shared, [scoped]).directory.listings[0]?.download_block_reason,
    explanation,
  );
  for (const restrictions of [
    [permit],
    [hold, { ...permit, operations: ["launch"] }],
    [hold, { ...permit, scope: undefined }],
    [hold, { ...permit, reason: "bundled-game-data" }],
    [hold, { ...hold }],
    [hold, { ...permit, scope: { inputs: ["source-profile"] } }],
    [hold, { ...permit, scope: { components: [{ kind: "tool-artifact", id: "tool" }] } }],
    [{ ...hold, operations: ["launch"] }],
    [{ ...hold, operations: ["register-external"] }],
  ])
    assert.throws(() =>
      checkedAuthoredPort({
        ...record,
        listing: {
          ...record.listing,
          release_url: "https://example.org/project/releases",
          restrictions: structuredClone(restrictions) as never,
        },
      }),
    );
  assert.ok(source.records.length > 0);
});

void test("managed restrictions are authored typed and emitted as the unchanged legacy hold", () => {
  const source = readCatalogSource(catalogRoot);
  const embedded = fixtureJson(readFileSync(join(catalogRoot, "catalog.json")));
  const ports = fixtureRecords(embedded.ports);
  let held = 0;
  for (const record of source.records) {
    const typed = record.integration?.acquisition_restrictions;
    if (typed === undefined) continue;
    held++;
    const port = ports.find((candidate) => candidate.id === record.listing.id);
    const hold = port?.managed_acquisition_hold;
    assert.ok(hold, record.listing.id);
    assert.deepEqual(restrictionsFromManagedHold(hold as LegacyManagedHold), typed);
    assert.deepEqual(managedHoldFromRestrictions(record.listing.id, typed as never), hold);
  }
  assert.equal(held, 5);
  const metroid = source.records.find(({ listing }) => listing.id === "super-metroid-recomp");
  assert.ok(metroid?.integration);
  const restrictions = structuredClone(metroid.integration.acquisition_restrictions) as Record<
    string,
    unknown
  >[];
  const unrepresentable = [
    (r: Record<string, unknown>[]) => (r[0]!.tracking_issue = 164),
    (r: Record<string, unknown>[]) => (r[0]!.scope = { platforms: ["windows-x86-64"] }),
    (r: Record<string, unknown>[]) => (r[2]!.operations = ["install", "activate"]),
    (r: Record<string, unknown>[]) => r.reverse(),
  ];
  for (const change of unrepresentable) {
    const changed = structuredClone(restrictions);
    change(changed);
    assert.throws(
      () =>
        checkedAuthoredPort({
          ...metroid,
          integration: { ...metroid.integration, acquisition_restrictions: changed },
        }),
      /cannot yet be delivered/,
    );
  }
  assert.throws(
    () =>
      checkedAuthoredPort({
        ...metroid,
        integration: {
          ...metroid.integration,
          acquisition_restrictions: [
            { ...restrictions[0], operations: ["download", "launch"] },
            ...restrictions.slice(1),
          ],
        },
      }),
    /outside the integration carrier/,
  );
  assert.throws(
    () =>
      checkedAuthoredPort({
        ...metroid,
        integration: { ...metroid.integration, managed_acquisition_hold: {} },
      }),
    /managed_acquisition_hold is derived/,
  );
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

void test("typed IGDB scenes project to listing format 13 without changing strict media", () => {
  const catalog = fixtureCatalog(fixtureJson(readFileSync(join(catalogRoot, "catalog.json"))));
  const authored = authoringRecordFromPort(requiredFixture(catalog.ports[0]), 0);
  const { ports: _ports, ...shared } = catalog;
  const typed = { id: "igdb", role: "screenshot", igdb: { kind: "screenshot" } };
  const legacy = { id: "legacy", role: "header" };
  for (const strict of [[legacy], []]) {
    const projection = assembleCatalogRecords(shared, [
      { ...authored, listing: { ...authored.listing, media: [...strict, typed] } },
    ]);
    assert.equal(projection.directory.format_version, 13);
    assert.deepEqual(projection.directory.listings[0]?.media, [...strict, typed]);
    const presentation = projection.catalog.ports[0]?.presentation as Record<string, unknown>;
    assert.deepEqual(presentation.media, strict.length ? strict : undefined);
  }
});

void test("verified source identities belong only in the format 14 listing", () => {
  const catalog = fixtureCatalog(fixtureJson(readFileSync(join(catalogRoot, "catalog.json"))));
  const authored = authoringRecordFromPort(requiredFixture(catalog.ports[0]), 0);
  const { ports: _ports, ...shared } = catalog;
  const binding = {
    game_id: "source-game",
    variant_id: "original-retail",
    representation_id: "original-file",
  };
  const edition = {
    id: "retail",
    title: "Original retail",
    evidence_urls: ["https://example.com/original"],
    verified_sources: [binding],
  };
  const listing = {
    ...authored.listing,
    original_game: {
      format_version: 1 as const,
      id: "original-game",
      evidence_urls: ["https://example.com/game"],
      source_editions: [edition],
    },
  };
  const result = assembleCatalogRecords(shared, [{ ...authored, listing }]);
  const presentation = result.catalog.ports[0]?.presentation as Record<string, unknown>;
  assert.equal(result.directory.format_version, 14);
  assert.deepEqual(result.directory.listings[0]?.original_game, listing.original_game);
  const { verified_sources: _sources, ...legacyEdition } = edition;
  assert.deepEqual(presentation.original_game, {
    ...listing.original_game,
    source_editions: [legacyEdition],
  });
  edition.verified_sources.push(binding);
  assert.throws(
    () => assembleCatalogRecords(shared, [{ ...authored, listing }]),
    /Duplicate verified source binding/,
  );
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
  assert.equal(projected.directory.format_version, source.directory.format_version);
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

void test("an accepted original screenshot follows the exact edition into existing and future listings", () => {
  const { authored } = readCatalogSource(catalogRoot);
  const shared = fixtureJson(readFileSync(join(catalogRoot, "catalog-shared.json")));
  const donor = authored.find(({ listing }) => listing.id === "zelda64-recomp")!;
  const recipient = authored.find(({ listing }) => listing.id === "2ship2harkinian")!;
  const future = {
    format_version: 1,
    listing: {
      id: "future-port-for-media-fixture",
      name: "Future port fixture",
      project_url: "https://example.com/future-port-for-media-fixture",
      summary: "An independent listing for the same original edition.",
      original_game: recipient.listing.original_game,
    },
  };
  const excluded = {
    ...future,
    listing: { ...future.listing, id: "excluded-media-fixture", media: [] },
  };
  const otherEdition = {
    ...future,
    listing: {
      ...future.listing,
      id: "other-edition-media-fixture",
      original_game: {
        ...future.listing.original_game!,
        source_editions: [
          {
            id: "other-edition-fixture",
            title: "An independent source edition",
            evidence_urls: ["https://example.com/other-edition"],
          },
        ],
      },
    },
  };
  const records = [recipient, future, excluded, otherEdition];
  const baseline = assembleCatalogRecords(shared, records);
  const withDonor = assembleCatalogRecords(shared, [donor, ...records]);
  const listings = new Map(withDonor.directory.listings.map((item) => [item.id, item]));
  assert.deepEqual(listings.get(recipient.listing.id)?.media, donor.listing.media);
  assert.deepEqual(listings.get(future.listing.id)?.media, donor.listing.media);
  assert.deepEqual(listings.get(excluded.listing.id)?.media, []);
  assert.equal(listings.get(otherEdition.listing.id)?.media, undefined);
  assert.deepEqual(
    withDonor.catalog.ports.find(({ id }) => id === recipient.listing.id),
    baseline.catalog.ports.find(({ id }) => id === recipient.listing.id),
  );
  assert.equal(
    baseline.directory.listings.find(({ id }) => id === recipient.listing.id)?.media,
    undefined,
  );
  const originalAsset = requiredFixture(fixtureRecords(donor.listing.media)[0]);
  const conflictingAsset = { ...originalAsset, sha256: "f".repeat(64) };
  const competingDonor = {
    ...future,
    listing: {
      ...future.listing,
      id: "conflicting-media-fixture",
      media: [conflictingAsset],
    },
  };
  const conflict = assembleCatalogRecords(shared, [donor, competingDonor, ...records]);
  assert.equal(
    conflict.directory.listings.find(({ id }) => id === recipient.listing.id)?.media,
    undefined,
  );
  assert.deepEqual(
    conflict.directory.listings.find(({ id }) => id === competingDonor.listing.id)?.media,
    [conflictingAsset],
  );

  const bothEditions = {
    ...future,
    listing: {
      ...future.listing,
      original_game: {
        ...future.listing.original_game!,
        source_editions: [
          ...future.listing.original_game!.source_editions,
          ...otherEdition.listing.original_game.source_editions,
        ],
      },
    },
  };
  const competingEdition = {
    ...otherEdition,
    listing: {
      ...otherEdition.listing,
      media: [
        {
          ...conflictingAsset,
          subject: {
            ...fixtureRecord(originalAsset.subject),
            source_edition_id: "other-edition-fixture",
          },
        },
      ],
    },
  };
  for (const donors of [
    [donor, competingEdition],
    [donor, competingDonor, competingEdition],
  ]) {
    const crossEditionConflict = assembleCatalogRecords(shared, [...donors, bothEditions]);
    assert.equal(
      crossEditionConflict.directory.listings.find(({ id }) => id === bothEditions.listing.id)
        ?.media,
      undefined,
    );
  }
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
  assert.ok(source.directory.format_version >= 6, "listing guide references require format 6");
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
  assert.equal(assembled.directory.format_version, accepted.directory.format_version);
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
  assert.equal(combined.directory.format_version, accepted.directory.format_version);
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
      record.psx_managed_windows_v1 &&
      record.psx_managed_windows_v1 !== "technically-computers" &&
      record.psx_managed_windows_v1 !== "technically-computers-input-files",
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
  assert.throws(
    () => checkedAuthoredPort(incorrectRoute),
    /persistence requires platforms windows-x86-64, macos-x86-64, macos-aarch64 in that order/u,
  );
  const tomba = requiredFixture(records.find(({ listing }) => listing.id === "tomba-recompiled"));
  assert.equal(tomba.psx_managed_windows_v1, undefined);
  assert.equal(compactPsxManagedWindows(tomba), tomba);
});

void test("TechnicallyComputers PSX input files expand by declared kit and raw disc facts", () => {
  const { records } = readCatalogSource(catalogRoot);
  const accepted = new Map(fixtureRecords(schema3Fixture.ports).map((port) => [port.id, port]));
  const family = records.filter(
    (record) => record.psx_managed_windows_v1 === "technically-computers-input-files",
  );
  assert.deepEqual(family.map(({ listing }) => listing.id).sort(), [
    "bomberman-party-edition-recompiled",
    "final-fantasy-vii-recompiled",
  ]);
  for (const record of family) {
    const id = record.listing.id;
    const projected = projectAuthoredPort(record);
    assert.ok(projected);
    assert.equal(JSON.stringify(projected), JSON.stringify(accepted.get(id)), id);
    assert.deepEqual(projected.persistent_paths, [
      "saves",
      "config",
      "mods",
      "settings.toml",
      "game_options.json",
      "graphics.json",
      "input.json",
      "sound.json",
      "input.ini",
      "keybinds.ini",
    ]);
    assert.equal(record.integration?.runtime_subdirectory, "build-portcove");
    assert.deepEqual(record.integration?.runtime_mutable_paths, [
      "bios.cfg",
      "disc.cfg",
      "psx_freeze_heartbeat.json",
      "psx_last_run_report.json",
    ]);

    const duplicate = structuredClone(record);
    duplicate.integration!.persistent_paths = [];
    assert.throws(() => projectPsxManagedWindows(duplicate), /already own the persistent paths/u);

    const downgrade = structuredClone(record);
    downgrade.psx_managed_windows_v1 = "technically-computers";
    assert.throws(
      () => projectPsxManagedWindows(downgrade),
      /persistence requires no (?:runtime_mutable_paths|multidisc fields)/u,
    );
    downgrade.psx_managed_windows_v1 = true;
    assert.throws(() => projectPsxManagedWindows(downgrade), /reviewed Windows GitHub kit/u);

    // Identity, repository and disc profile are data: another record with the
    // same declared shape expands to the same layout.
    const otherKit = structuredClone(record);
    otherKit.listing.id = "other-port";
    otherKit.listing.project_url = "https://github.com/other-owner/OtherKit";
    (otherKit.integration!.release as Record<string, unknown>).repository = "other-owner/OtherKit";
    otherKit.integration!.source_profile = "other-source";
    const otherProjected = projectPsxManagedWindows(otherKit).integration!;
    const ownProjected = projectPsxManagedWindows(record).integration!;
    assert.deepEqual(otherProjected.persistent_paths, ownProjected.persistent_paths);
    assert.equal(otherProjected.source_profile, "other-source");

    const unexpectedRoot = structuredClone(record);
    unexpectedRoot.integration!.runtime_subdirectory = "other-root";
    assert.throws(
      () => projectPsxManagedWindows(unexpectedRoot),
      /input files require an explicit build-portcove runtime_subdirectory/u,
    );
    const missingMutable = structuredClone(record);
    delete missingMutable.integration!.runtime_mutable_paths;
    assert.throws(
      () => projectPsxManagedWindows(missingMutable),
      /input files require explicit runtime_mutable_paths/u,
    );
  }
  const finalFantasy = requiredFixture(
    family.find(({ listing }) => listing.id === "final-fantasy-vii-recompiled"),
  );
  assert.equal(finalFantasy.integration?.runtime_source_filename, "runtime-discs");
  assert.equal(finalFantasy.integration?.runtime_source_materialization, "psx-raw-set");
  assert.deepEqual(finalFantasy.integration?.launch_arguments, ["--no-launcher"]);
  const wrongDiscSet = projectPsxManagedWindows(structuredClone(finalFantasy));
  delete wrongDiscSet.psx_managed_windows_v1;
  wrongDiscSet.integration!.runtime_source_materialization = "copy";
  assert.equal(compactPsxManagedWindows(wrongDiscSet), wrongDiscSet);
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

void test("PSX split-mods without a crash log drops only the crash log", () => {
  const { records } = readCatalogSource(catalogRoot);
  const family = records.filter(
    (record) => record.psx_managed_windows_v1 === "split-mods-no-crash-log",
  );
  assert.deepEqual(family.map(({ listing }) => listing.id).sort(), [
    "alexbeav-bloody-roar-ii-recomp",
    "alexbeav-brave-fencer-musashi-recomp",
    "alexbeav-destruction-derby-2-recomp",
    "alexbeav-destruction-derby-raw-recomp",
    "alexbeav-dino-crisis-2-recomp",
    "alexbeav-dino-crisis-recomp",
  ]);
  const mutablePaths = [
    "cache",
    "psx_freeze_heartbeat.json",
    "psx_freeze_heartbeat.json.tmp",
    "psx_last_run_report.json",
    "psx_cps_exit_trace.json",
    "netplay_lan_lobby.txt",
  ];
  for (const record of family) {
    const thin = projectPsxManagedWindows(record).integration;
    assert.ok(thin);
    assert.deepEqual(thin.runtime_mutable_paths, mutablePaths);
    const common = projectPsxManagedWindows({
      ...record,
      psx_managed_windows_v1: "split-mods",
    }).integration;
    assert.deepEqual(common, {
      ...thin,
      runtime_mutable_paths: [...mutablePaths, "psx_crash.txt"],
    });
  }
  const record = family[0]!;
  const otherSource = {
    ...record,
    listing: { ...record.listing, project_url: "https://github.com/fork/port" },
  };
  assert.throws(
    () => projectPsxManagedWindows(otherSource),
    /release repository that is the listing project_url/u,
  );
  const otherUpstream = structuredClone(record);
  otherUpstream.listing.id = "other-port";
  otherUpstream.listing.project_url = "https://github.com/other-owner/other-kit";
  (otherUpstream.integration!.release as Record<string, unknown>).repository =
    "other-owner/other-kit";
  assert.deepEqual(
    projectPsxManagedWindows(otherUpstream).integration!.runtime_mutable_paths,
    mutablePaths,
  );
  const otherBios = {
    ...record,
    integration: { ...record.integration, bios_source_profile: "psx-scph-5552-bios" },
  };
  assert.throws(() => projectPsxManagedWindows(otherBios), /retail SCPH-1001 BIOS/u);
});

void test("PSX diagnostics routes are explicit and the title-keyed layout is refused", () => {
  const { records } = readCatalogSource(catalogRoot);
  const accepted = new Map(fixtureCatalog(schema3Fixture).ports.map((port) => [port.id, port]));
  const diagnostics = records.filter((record) =>
    (record.integration?.persistent_paths as unknown[] | undefined)?.includes(
      "diagnostics-location.txt",
    ),
  );
  assert.ok(diagnostics.length > 0);
  for (const record of diagnostics) {
    const { id } = record.listing;
    assert.equal(record.psx_managed_windows_v1, undefined, id);
    assert.equal(JSON.stringify(projectAuthoredPort(record)), JSON.stringify(accepted.get(id)), id);
    assert.equal(compactPsxManagedWindows(record), record, id);
    assert.throws(
      () =>
        projectPsxManagedWindows({
          ...record,
          psx_managed_windows_v1: "split-mods-diagnostics",
        } as unknown as AuthoredPort),
      /Missing: a known layout, not "split-mods-diagnostics"/u,
    );
  }
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
      () =>
        checkedAuthoredPort({
          ...explicit,
          n64_recomp_persistence_v1: record.n64_recomp_persistence_v1,
        }),
      /already own persistent_paths/u,
    );
  }

  const nested = records.find((record) => record.listing.id === "beetle-recomp")!;
  const otherProvider = records.find((record) => record.listing.id === "extreme-g-recompiled")!;
  for (const [explicit, missing] of [
    [nested, /require no runtime_subdirectory/u],
    [otherProvider, /require a GitHub release repository/u],
  ] as const) {
    assert.equal(compactN64RecompPersistence(explicit), explicit);
    assert.throws(
      () => checkedAuthoredPort({ ...explicit, n64_recomp_persistence_v1: true }),
      missing,
    );
  }

  const unsafe = structuredClone(consumers[0]!);
  unsafe.integration!.runtime_source_filename = "../alias.z64";
  assert.throws(
    () => checkedAuthoredPort(unsafe),
    /require a root-level \.z64 runtime_source_filename/u,
  );
});

void test("N64 persistence additions are declared variants in the reviewed writer order", () => {
  const { records } = readCatalogSource(catalogRoot);
  const dinosaur = records.find((record) => record.listing.id === "dinosaur-planet")!;
  const donkeyKong = records.find((record) => record.listing.id === "donkey-kong-64-recompiled")!;
  assert.equal(dinosaur.n64_recomp_persistence_v1, "config-directory");
  assert.equal(donkeyKong.n64_recomp_persistence_v1, "technical-settings");
  const dinosaurPaths = projectAuthoredPort(dinosaur)?.persistent_paths;
  const donkeyKongPaths = projectAuthoredPort(donkeyKong)?.persistent_paths;
  assert.ok(Array.isArray(dinosaurPaths) && Array.isArray(donkeyKongPaths));
  assert.deepEqual(dinosaurPaths.slice(0, 5), [
    "mods",
    "mod_config",
    "saves",
    "config",
    "mods.json",
  ]);
  assert.deepEqual(donkeyKongPaths.slice(-4), [
    "sound.json.bak",
    "technical.json",
    "technical.json.bak",
    "DK64.z64",
  ]);
  for (const [record, additions] of [
    [dinosaur, ["config"]],
    [donkeyKong, ["technical.json", "technical.json.bak"]],
  ] as const) {
    // The variant is the record's declaration, not its identity: the shared
    // layout omits exactly the additions, and compaction picks the variant
    // that reproduces the explicit paths.
    const shared = projectN64RecompPersistence({ ...record, n64_recomp_persistence_v1: true });
    const own = projectN64RecompPersistence(record);
    assert.deepEqual(
      shared.integration!.persistent_paths,
      (own.integration!.persistent_paths as string[]).filter(
        (path) => !additions.some((addition) => addition === path),
      ),
    );
    delete shared.n64_recomp_persistence_v1;
    assert.equal(compactN64RecompPersistence(shared).n64_recomp_persistence_v1, true);
    const changed = structuredClone(shared);
    changed.integration!.persistent_paths = ["custom-saves"];
    assert.equal(compactN64RecompPersistence(changed), changed);
  }
  assert.throws(
    () => checkedAuthoredPort({ ...donkeyKong, n64_recomp_persistence_v1: ["technical-settings"] }),
    /take true, "config-directory" or "technical-settings"/u,
  );
  const otherOriginal = projectN64RecompPersistence({
    ...donkeyKong,
    integration: { ...donkeyKong.integration, source_profile: "different-original" },
  });
  assert.deepEqual(otherOriginal.integration!.persistent_paths, donkeyKongPaths);
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
  const implementationOnly = structuredClone(record);
  delete implementationOnly.listing.media;
  const { ports: _ports, ...shared } = source.catalog;
  assert.equal(assembleCatalogRecords(shared, [implementationOnly]).directory.format_version, 12);
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

// A synthetic upstream no script may name: retained shorthands must expand it
// from its declared fields alone.
const unfamiliarId = "unfamiliar-shorthand-fixture-port";
const unfamiliarRepository = "unfamiliar-fixture-owner/unfamiliar-fixture-kit";

function unfamiliarRecord(
  shorthand: Partial<AuthoredPort>,
  integration: Record<string, unknown>,
): AuthoredPort {
  return {
    format_version: 1,
    listing: {
      id: unfamiliarId,
      name: "Unfamiliar fixture",
      summary: "Unfamiliar fixture",
      project_url: `https://github.com/${unfamiliarRepository}`,
    },
    ...shorthand,
    integration: {
      support_tier: "beta",
      channels: ["stable"],
      ...integration,
      presentation: { installation_method: "portable-package" },
    },
  };
}

function unfamiliarPsx(layout: NonNullable<AuthoredPort["psx_managed_windows_v1"]>) {
  const technicallyComputers =
    layout === "technically-computers" || layout === "technically-computers-input-files";
  const dual = typeof layout === "string" && layout.startsWith("split-mods");
  const openBios = layout === "bundled-openbios" || layout === "split-mods-openbios";
  const platforms = technicallyComputers
    ? ["windows-x86-64", "macos-x86-64", "macos-aarch64"]
    : dual
      ? ["windows-x86-64", "linux-x86-64"]
      : ["windows-x86-64"];
  const assets: Record<string, string[]> = technicallyComputers
    ? {
        "windows-x86-64": ["windows-x64"],
        "macos-x86-64": ["macos-x64"],
        "macos-aarch64": ["macos-arm64"],
      }
    : dual
      ? {
          "windows-x86-64": ["unfamiliar-kit-", "-windows-x64.zip"],
          "linux-x86-64": ["unfamiliar-kit-", "-linux-x64.zip"],
        }
      : { "windows-x86-64": ["unfamiliar-kit-windows.zip"] };
  const executables = Object.fromEntries(
    platforms.map((platform) => [
      platform,
      [platform === "windows-x86-64" ? "UnfamiliarPlayer.exe" : "UnfamiliarPlayer"],
    ]),
  );
  return unfamiliarRecord(
    { psx_managed_windows_v1: layout },
    {
      platforms,
      automated_tested_platforms: [],
      manually_validated_platforms: [],
      adapter: "psx-recomp-managed",
      release: { provider: "github", repository: unfamiliarRepository, asset_hints: assets },
      source_profile: "unfamiliar-disc-psx",
      executable_hints: executables,
      ...(layout === "technically-computers-input-files"
        ? { runtime_subdirectory: "build-portcove", runtime_mutable_paths: ["unfamiliar.cfg"] }
        : {}),
      ...(openBios || technicallyComputers ? {} : { bios_source_profile: "psx-scph-1001-bios" }),
    },
  );
}

void test("retained shorthands expand an unfamiliar upstream by its declared fields alone", () => {
  const { records } = readCatalogSource(catalogRoot);
  const layouts = [
    true,
    "bundled-openbios",
    "split-mods",
    "split-mods-no-crash-log",
    "split-mods-openbios",
    "split-mods-overlay-directory",
    "technically-computers",
    "technically-computers-input-files",
  ] as const;
  for (const layout of layouts) {
    const fixture = unfamiliarPsx(layout);
    const declared = fixture.integration!;
    const projected = projectPsxManagedWindows(fixture).integration!;
    // Every declared fact survives unchanged.
    for (const [field, value] of Object.entries(declared))
      assert.deepEqual(projected[field], value, `${String(layout)} ${field}`);
    const supplied = Object.keys(projected).filter((field) => !Object.hasOwn(declared, field));
    assert.ok(supplied.includes("persistent_paths"), String(layout));
    // The supplied layout equals what an accepted record of the same layout gets.
    const accepted = records.find((record) => record.psx_managed_windows_v1 === layout);
    if (accepted) {
      const reference = projectPsxManagedWindows(accepted).integration!;
      for (const field of supplied)
        assert.deepEqual(projected[field], reference[field], `${String(layout)} ${field}`);
    }
    // Compaction recognizes the unfamiliar explicit form too.
    const explicit = { ...fixture, integration: projected };
    delete explicit.psx_managed_windows_v1;
    assert.equal(compactPsxManagedWindows(explicit).psx_managed_windows_v1, layout);
  }
  assert.ok(
    (
      projectPsxManagedWindows(unfamiliarPsx(true)).integration!.persistent_paths as string[]
    ).includes("mods"),
  );
  assert.deepEqual(
    projectPsxManagedWindows(unfamiliarPsx("bundled-openbios")).integration!.launch_arguments,
    ["--no-launcher", "--bios", "bios/openbios.bin"],
  );

  const n64 = (variant: NonNullable<AuthoredPort["n64_recomp_persistence_v1"]>) =>
    unfamiliarRecord(
      { n64_recomp_persistence_v1: variant },
      {
        platforms: ["windows-x86-64"],
        adapter: "n64-recomp-portable",
        release: { repository: unfamiliarRepository },
        source_profile: "unfamiliar-cartridge",
        executable_hints: { "windows-x86-64": ["UnfamiliarRecomp.exe"] },
        runtime_source_filename: "unfamiliar.z64",
      },
    );
  const shared = [
    "mods.json",
    "mods.json.bak",
    "general.json",
    "general.json.bak",
    "graphics.json",
    "graphics.json.bak",
    "controls.json",
    "controls.json.bak",
    "sound.json",
    "sound.json.bak",
  ];
  for (const [variant, paths] of [
    [true, ["mods", "mod_config", "saves", ...shared, "unfamiliar.z64"]],
    ["config-directory", ["mods", "mod_config", "saves", "config", ...shared, "unfamiliar.z64"]],
    [
      "technical-settings",
      [
        "mods",
        "mod_config",
        "saves",
        ...shared,
        "technical.json",
        "technical.json.bak",
        "unfamiliar.z64",
      ],
    ],
  ] as const) {
    const projected = projectN64RecompPersistence(n64(variant)).integration!;
    assert.deepEqual(projected.persistent_paths, paths, String(variant));
    assert.deepEqual(
      Object.keys(projected).indexOf("persistent_paths") + 1,
      Object.keys(projected).indexOf("runtime_source_filename"),
    );
    const explicit = { ...n64(variant), integration: projected };
    delete explicit.n64_recomp_persistence_v1;
    assert.equal(compactN64RecompPersistence(explicit).n64_recomp_persistence_v1, variant);
  }
});

void test("retained shorthands refuse an unfamiliar upstream naming the missing precondition", () => {
  const without = (record: AuthoredPort, field: string) => {
    const copy = structuredClone(record);
    delete copy.integration![field];
    return copy;
  };
  for (const layout of [true, "split-mods", "split-mods-overlay-directory"] as const)
    assert.throws(
      () => projectPsxManagedWindows(without(unfamiliarPsx(layout), "source_profile")),
      /Missing: an explicit source_profile\./u,
    );
  assert.throws(
    () => projectPsxManagedWindows(without(unfamiliarPsx(true), "bios_source_profile")),
    /Missing: a retail bios_source_profile\./u,
  );
  const extraBios = structuredClone(unfamiliarPsx("bundled-openbios"));
  extraBios.integration!.bios_source_profile = "psx-scph-1001-bios";
  assert.throws(() => projectPsxManagedWindows(extraBios), /Missing: no bios_source_profile\./u);
  const noLinuxAsset = structuredClone(unfamiliarPsx("split-mods"));
  delete fixtureRecord(fixtureRecord(noLinuxAsset.integration!.release).asset_hints)[
    "linux-x86-64"
  ];
  assert.throws(
    () => projectPsxManagedWindows(noLinuxAsset),
    /Missing: a linux-x86-64 asset_hint\./u,
  );
  const otherBios = structuredClone(unfamiliarPsx("split-mods-no-crash-log"));
  otherBios.integration!.bios_source_profile = "psx-scph-5552-bios";
  assert.throws(() => projectPsxManagedWindows(otherBios), /requires the retail SCPH-1001 BIOS/u);
  const otherSelector = structuredClone(unfamiliarPsx("technically-computers"));
  fixtureRecord(fixtureRecord(otherSelector.integration!.release).asset_hints)["windows-x86-64"] = [
    "other",
  ];
  assert.throws(
    () => projectPsxManagedWindows(otherSelector),
    /persistence requires asset_hints windows-x86-64: windows-x64, macos-x86-64: macos-x64, macos-aarch64: macos-arm64\./u,
  );
  assert.throws(
    () =>
      projectPsxManagedWindows(
        without(unfamiliarPsx("technically-computers-input-files"), "runtime_mutable_paths"),
      ),
    /input files require explicit runtime_mutable_paths\./u,
  );
  const n64 = unfamiliarRecord(
    { n64_recomp_persistence_v1: "config-directory" },
    {
      platforms: ["windows-x86-64"],
      adapter: "n64-recomp-portable",
      release: { repository: unfamiliarRepository },
      source_profile: "unfamiliar-cartridge",
    },
  );
  assert.throws(
    () => projectN64RecompPersistence(n64),
    /require a root-level \.z64 runtime_source_filename\./u,
  );
  assert.throws(
    () =>
      projectN64RecompPersistence(
        without(
          { ...n64, integration: { ...n64.integration, runtime_source_filename: "a.z64" } },
          "source_profile",
        ),
      ),
    /require an explicit source_profile\./u,
  );
});

void test("the unfamiliar fixture upstream appears in no non-test script", () => {
  const scripts = fileURLToPath(new URL(".", import.meta.url));
  for (const entry of readdirSync(scripts, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".mts") || entry.name.endsWith(".test.mts"))
      continue;
    const text = readFileSync(join(entry.parentPath, entry.name), "utf8");
    for (const name of [unfamiliarId, unfamiliarRepository, "unfamiliar-fixture-owner"])
      assert.equal(text.includes(name), false, `${entry.name} names ${name}`);
  }
});

void test("retired shorthands are refused instead of silently dropping their fields", () => {
  const { records } = readCatalogSource(catalogRoot);
  const record = requiredFixture(records.find((entry) => entry.integration !== undefined));
  for (const field of [
    "alephone_pinned_windows_v1",
    "chocolate_family_windows_persistence_v1",
    "crispy_doom_windows_persistence_v1",
    "gen2recomp_windows_persistence_v1",
    "native_managed_profile_v1",
    "opengoal_setup_v1",
    "openmohaa_portable_v1",
    "openx_portable_v1",
    "raze_windows_profile_v1",
    "reflectionhle_portable_paths_v1",
    "rsdkv4_portable_data_v1",
  ])
    assert.throws(
      () => checkedAuthoredPort({ ...record, [field]: true }),
      new RegExp(
        `${field} is retired; author the integration fields it supplied explicitly\\.$`,
        "u",
      ),
    );
});

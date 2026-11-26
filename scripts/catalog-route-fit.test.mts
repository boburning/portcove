import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readCatalogSource, type AuthoredPort, type CatalogPort } from "./catalog-authoring.mts";
import {
  checkRouteFitReport,
  dispositions,
  heldAt,
  main,
  routeFitReport,
  serializeRouteFitReport,
  type RouteFitInputs,
} from "./catalog-route-fit.mts";
import { fixtureListing, fixturePolicy } from "./fixtures/listing-observation-delivery-fixture.mts";
import { listingUpdatesForReport } from "./listing-upstream-observation.mts";

const root = fileURLToPath(new URL("../", import.meta.url));

function listing(id: string, fields: Record<string, unknown> = {}, extra = {}): AuthoredPort {
  return {
    format_version: 1,
    listing: {
      id,
      name: `Name ${id}`,
      summary: "Summary.",
      project_url: `https://github.com/owner/${id}`,
      ...fields,
    },
    ...extra,
  };
}
const runtime = (project_url: string) => ({
  implementation: {
    format_version: 1,
    methods: [{ kind: "engine-reimplementation", evidence_urls: [project_url] }],
    dependencies: [
      { kind: "runtime", project_url, name: "Engine", confidence: "confirmed", evidence_urls: [] },
    ],
  },
});
const restriction = (
  id: string,
  effect: "hold" | "permit",
  operations: string[],
  scope?: Record<string, unknown>,
) => ({
  id,
  effect,
  operations,
  ...(effect === "hold" ? { reason: "bundled-game-data" } : {}),
  ...(scope ? { scope } : {}),
});
const packages = (...platforms: string[]) => ({ availability: "packages", platforms });
const preparedPlayer = {
  route_facts_v1: {
    format_version: 1,
    prepared_player: {
      executable: "Game.exe",
      working_directory: "executable-parent",
      arguments: [],
      data_locations: ["the game's profile folder"],
    },
  },
};

function fixture(): RouteFitInputs {
  const records = [
    listing("managed-port"),
    listing("prepared-route", packages("windows-x86-64")),
    listing("prepared-facts", packages("windows-x86-64"), preparedPlayer),
    listing("never-seen-by-code", packages("linux-x86-64", "windows-x86-64")),
    listing("unknown-github", { availability: "unknown", platforms: ["windows-x86-64"] }),
    listing("gitlab-packages", {
      ...packages("windows-x86-64"),
      project_url: "https://gitlab.com/group/project",
    }),
    listing("no-known-platform", packages()),
    listing("other-host", { project_url: "https://example.org/game" }),
    listing("other-host-packages", {
      ...packages("windows-x86-64"),
      project_url: "https://example.org/game",
    }),
    listing("source-only", { availability: "source-only", platforms: ["windows-x86-64"] }),
    listing("download-held", {
      ...packages("windows-x86-64"),
      restrictions: [restriction("download", "hold", ["download"])],
    }),
    // Neither the id, the name nor the project names the engine; only the runtime does.
    listing("adventure-classic", {
      ...packages("windows-x86-64"),
      name: "Classic Adventure",
      project_url: "https://github.com/someone/classic-adventure",
      ...runtime("https://github.com/ScummVM/scummvm.git"),
    }),
    // ScummVM is decided before an operational definition.
    listing("operational-scummvm", runtime("https://github.com/scummvm/scummvm")),
    // A name that mentions ScummVM but runs another engine is not excluded.
    listing("scummvm-named-elsewhere", {
      ...packages("windows-x86-64"),
      name: "Not ScummVM",
      ...runtime("https://github.com/other/engine"),
    }),
  ];
  const ports = [
    { id: "managed-port", adapter: "native-portable", release: { repository: "owner/managed" } },
    { id: "operational-scummvm", adapter: "native-portable", release: {} },
  ] as CatalogPort[];
  return {
    records,
    ports,
    packageShapes: { entries: [{ port_id: "managed-port" }] },
    routeEnrollment: { cases: [{ port_id: "prepared-route" }] },
  };
}

const fitOf = (report: ReturnType<typeof routeFitReport>, id: string) =>
  report.identities.find((identity) => identity.id === id)!;

void test("classifies each disposition from data alone", () => {
  const inputs = fixture();
  const report = routeFitReport(inputs);
  checkRouteFitReport(report, inputs.records);
  assert.deepEqual(
    Object.fromEntries(report.identities.map((identity) => [identity.id, identity.disposition])),
    {
      "adventure-classic": "excluded-scummvm",
      "download-held": "needs-bytes-worker",
      "gitlab-packages": "needs-bytes-worker",
      "managed-port": "enrolled",
      "never-seen-by-code": "needs-bytes-worker",
      "no-known-platform": "unobserved",
      "operational-scummvm": "excluded-scummvm",
      "other-host": "missing-capability",
      "other-host-packages": "missing-capability",
      "prepared-facts": "data-only",
      "prepared-route": "enrolled",
      "scummvm-named-elsewhere": "needs-bytes-worker",
      "source-only": "upstream-condition",
      "unknown-github": "unobserved",
    },
  );
  // Nothing a listing-only record can say declares a Portcove-owned route.
  for (const name of dispositions)
    assert.equal(report.summary.by_disposition[name] > 0, name !== "needs-admission", name);
  assert.equal(fitOf(report, "operational-scummvm").enrolled, true);
  assert.equal(fitOf(report, "adventure-classic").enrolled, false);
  assert.match(fitOf(report, "operational-scummvm").reason, /operational route also exists/u);
  const managed = fitOf(report, "managed-port");
  assert.deepEqual(managed.family, { adapter: "native-portable", provider: "github" });
  assert.match(managed.reason, /1 reviewed package shape/u);
  assert.match(fitOf(report, "unknown-github").reason, /unobserved/u);
  assert.doesNotMatch(fitOf(report, "unknown-github").reason, /absent/u);
  assert.match(
    fitOf(report, "other-host-packages").reason,
    /no release provider adapter reads example\.org/u,
  );
  assert.match(fitOf(report, "prepared-facts").reason, /prepared-player route facts/u);
  assert.match(fitOf(report, "never-seen-by-code").reason, /no player facts/u);
  assert.equal(report.summary.listing_only_github_packages_windows_x86_64, 6);
  assert.equal(report.summary.data_only_windows_x86_64, 1);
  assert.equal(report.summary.by_family["listing/gitlab"], 1);
  assert.equal(report.summary.by_family["listing/other"], 2);
});

void test("a download hold is reported, not flattened into the registration route", () => {
  const report = routeFitReport(fixture());
  const held = fitOf(report, "download-held");
  assert.equal(held.disposition, "needs-bytes-worker");
  assert.deepEqual(held.restrictions, [
    {
      id: "download",
      carrier: "listing",
      effect: "hold",
      operations: ["download"],
      scope: "whole",
      reason: "bundled-game-data",
    },
  ]);
  assert.deepEqual(Object.keys(held.held_operations), ["download"]);
  assert.match(held.reason, /download held on every platform: bundled-game-data/u);
  assert.equal(report.summary.listing_only_download_held, 1);
});

void test("restrictions change the disposition only when they remove every route operation", () => {
  const inputs = fixture();
  const withRestrictions = (
    restrictions: unknown[],
    platforms = ["linux-x86-64", "windows-x86-64"],
  ) =>
    fitOf(
      routeFitReport({
        ...inputs,
        records: [
          ...inputs.records.filter((record) => record.listing.id !== "prepared-facts"),
          listing("prepared-facts", { ...packages(...platforms), restrictions }, preparedPlayer),
        ],
      }),
      "prepared-facts",
    );
  // Platform-scoped holds covering every declared platform remove the route.
  const everywhere = withRestrictions([
    restriction("register", "hold", ["register-external"], {
      platforms: ["linux-x86-64", "windows-x86-64"],
    }),
  ]);
  assert.equal(everywhere.disposition, "upstream-condition");
  assert.match(everywhere.reason, /register-external held on linux-x86-64, windows-x86-64/u);
  // Covering only some platforms leaves the route on the others.
  const partial = withRestrictions([
    restriction("register", "hold", ["launch"], { platforms: ["windows-x86-64"] }),
  ]);
  assert.equal(partial.disposition, "needs-bytes-worker");
  assert.match(partial.reason, /launch held on windows-x86-64/u);
  // Operation scope: holds on other operations keep the registration route.
  const otherOperations = withRestrictions([
    restriction("managed", "hold", ["download", "install", "update"]),
  ]);
  assert.equal(otherOperations.disposition, "data-only");
  assert.deepEqual(Object.keys(otherOperations.held_operations), ["download", "install", "update"]);
  // A more specific permit that may still match clears a broader hold at offer time.
  const permitted = withRestrictions([
    restriction("launch-hold", "hold", ["register-external", "launch"]),
    restriction("reviewed", "permit", ["register-external", "launch"], {
      artifacts: [{ version: "v1", sha256: "a".repeat(64) }],
    }),
  ]);
  assert.equal(permitted.disposition, "data-only");
  assert.deepEqual(permitted.held_operations, {});
  assert.equal(permitted.restrictions.length, 2);
  // A permit at equal or broader specificity does not clear a hold.
  const notCleared = withRestrictions([
    restriction("launch-hold", "hold", ["register-external"], { platforms: ["windows-x86-64"] }),
    restriction("broad", "permit", ["register-external"]),
  ]);
  assert.match(notCleared.reason, /register-external held on windows-x86-64/u);
});

void test("restriction evaluation follows Core's offer-time semantics", () => {
  const record = (restrictions: unknown[], managed: unknown[] = []) =>
    listing(
      "subject",
      { restrictions },
      managed.length ? { integration: { acquisition_restrictions: managed } } : {},
    );
  // Exact releases and artifacts are deferred at offer, so their holds do not withhold it.
  assert.equal(
    heldAt(
      record([restriction("r", "hold", ["download"], { releases: ["v1"] })]),
      "download",
      "windows-x86-64",
    ),
    undefined,
  );
  // Core resolves no inputs yet, so a hold on them fails closed.
  assert.equal(
    heldAt(
      record([restriction("i", "hold", ["download"], { inputs: ["game-data"] })]),
      "download",
      "windows-x86-64",
    )?.id,
    "i",
  );
  // Platform scope applies only on its platforms.
  const scoped = record([restriction("p", "hold", ["download"], { platforms: ["linux-x86-64"] })]);
  assert.equal(heldAt(scoped, "download", "windows-x86-64"), undefined);
  assert.equal(heldAt(scoped, "download", "linux-x86-64")?.id, "p");
  // A more specific platform permit beats a whole hold; a hold wins a tie.
  const platformPermit = record([
    restriction("whole", "hold", ["download"]),
    restriction("windows", "permit", ["download"], { platforms: ["windows-x86-64"] }),
  ]);
  assert.equal(heldAt(platformPermit, "download", "windows-x86-64"), undefined);
  assert.equal(heldAt(platformPermit, "download", "linux-x86-64")?.id, "whole");
  // A permit cancels holds only in its own carrier.
  const crossCarrier = record(
    [restriction("listing", "hold", ["download"])],
    [restriction("managed", "permit", ["download"], { platforms: ["windows-x86-64"] })],
  );
  assert.equal(heldAt(crossCarrier, "download", "windows-x86-64")?.id, "listing");
});

void test("lists every identity exactly once and serializes byte-identically", () => {
  const inputs = fixture();
  const first = serializeRouteFitReport(routeFitReport(inputs));
  const reordered = { ...inputs, records: [...inputs.records].reverse() };
  assert.equal(serializeRouteFitReport(routeFitReport(reordered)), first);
  const ids = routeFitReport(inputs).identities.map((identity) => identity.id);
  assert.equal(new Set(ids).size, inputs.records.length);
  assert.doesNotMatch(first, /\d{4}-\d{2}-\d{2}T/u);
  const report = routeFitReport(inputs);
  assert.throws(
    () =>
      checkRouteFitReport({ ...report, identities: report.identities.slice(1) }, inputs.records),
    /exactly once/u,
  );
});

void test("refuses generated tables or observations that name unknown identities", () => {
  const inputs = fixture();
  assert.throws(
    () => routeFitReport({ ...inputs, routeEnrollment: { cases: [{ port_id: "missing" }] } }),
    /missing is not a catalog identity/u,
  );
  assert.throws(
    () => routeFitReport({ ...inputs, observerReport: [{ id: "missing" }] }),
    /not a catalog identity/u,
  );
});

void test("observer output: complete observations count, other statuses stay unobserved", () => {
  const observed = { ...fixtureListing };
  const inputs = { ...fixture(), records: [...fixture().records, listing(observed.id, observed)] };
  const policy = fixturePolicy(observed);
  assert.equal(policy.listing_update.upstream_observation.status, "complete");
  const fit = (observerReport: unknown) =>
    fitOf(routeFitReport({ ...inputs, observerReport }), observed.id);

  for (const report of [[policy], [policy.listing_update], { listings: [policy.listing_update] }]) {
    const complete = fit(report);
    assert.equal(complete.disposition, "needs-bytes-worker");
    assert.equal(complete.observation, "complete");
    assert.match(complete.reason, /windows-x86-64 \(complete observation\)/u);
  }
  // Legacy successful records carry no status.
  const { status: _status, ...legacy } = policy.listing_update.upstream_observation;
  assert.equal(
    fit([{ ...policy.listing_update, upstream_observation: legacy }]).disposition,
    "needs-bytes-worker",
  );
  // A complete observation must bind its facts; without the digest it is incomplete.
  const { facts_sha256: _digest, ...unbound } = policy.listing_update.upstream_observation;
  const unboundFit = fit([{ ...policy.listing_update, upstream_observation: unbound }]);
  assert.equal(unboundFit.observation, "incomplete");
  assert.equal(unboundFit.disposition, "unobserved");

  const source = { repository: "owner/game", ports: [{ listing: observed }] };
  for (const [rule, status] of [
    ["request-budget", "incomplete"],
    ["provider-unavailable", "unavailable"],
    ["invalid-response", "failed"],
  ] as const) {
    const updates = listingUpdatesForReport(
      [],
      { exception: { rule } },
      "2026-11-11T00:00:00Z",
      source,
    );
    assert.equal(updates[0]!.upstream_observation.status, status);
    const result = fit(updates);
    assert.equal(result.disposition, "unobserved", status);
    assert.equal(result.observation, status);
    assert.match(result.reason, new RegExp(`latest observation is ${status}`, "u"));
  }

  // A complete observation without packages, or without a desktop hint.
  const releases = policy.listing_update.upstream_observation.releases as Record<string, unknown>[];
  const withReleases = (value: unknown[]) => [
    {
      ...policy.listing_update,
      upstream_observation: { ...policy.listing_update.upstream_observation, releases: value },
    },
  ];
  assert.equal(
    fit(withReleases([{ ...releases[0], assets: [] }])).disposition,
    "upstream-condition",
  );
  const unhinted = (releases[0]!.assets as Record<string, unknown>[]).map((asset) => ({
    ...asset,
    platform_hints: [],
  }));
  assert.equal(
    fit(withReleases([{ ...releases[0], assets: unhinted }])).disposition,
    "missing-capability",
  );
});

void test("an accepted package player observation supplies data-only player facts", () => {
  const { records, catalog } = readCatalogSource(join(root, "crates/portcove-core/catalog"));
  const operational = new Set(catalog.ports.map((port) => port.id));
  const observed = records.find(
    (record) => record.package_observation_v1 && !operational.has(record.listing.id),
  );
  assert.ok(observed, "the catalog retains a listing-only package player observation");
  // Without its generated enrollment the record still fits from data alone.
  const report = routeFitReport({
    records: [observed],
    ports: [],
    packageShapes: { entries: [] },
    routeEnrollment: { cases: [] },
  });
  assert.equal(report.identities[0]!.disposition, "data-only");
  assert.match(report.identities[0]!.reason, /accepted package player observation/u);
});

void test("the committed catalog classifies every identity exactly once", () => {
  const directory = mkdtempSync(join(tmpdir(), "route-fit-"));
  try {
    const output = join(directory, "route-fit.json");
    const first = main(["--check", "--json", "--output", output], root);
    assert.equal(main(["--json"], root), first);
    const report = JSON.parse(first) as ReturnType<typeof routeFitReport>;
    const total = Object.values(report.summary.by_disposition).reduce((sum, n) => sum + n, 0);
    assert.equal(total, report.summary.identities);
    assert.equal(
      report.summary.identities,
      report.summary.operational_definitions + report.summary.listing_only,
    );
    assert.equal(report.summary.by_disposition["needs-admission"], 0);
    const empty = join(directory, "observations.json");
    writeFileSync(empty, "[]");
    assert.match(main(["--observations", empty], root), /Catalog route fit: \d+ identities/u);
    assert.throws(() => main(["--unknown"], root), /Usage/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { AuthoredPort, CatalogPort } from "./catalog-authoring.mts";
import {
  checkRouteFitReport,
  dispositions,
  main,
  routeFitReport,
  serializeRouteFitReport,
  type RouteFitInputs,
} from "./catalog-route-fit.mts";

const root = fileURLToPath(new URL("../", import.meta.url));

function listing(id: string, fields: Record<string, unknown> = {}): AuthoredPort {
  return {
    format_version: 1,
    listing: {
      id,
      name: `Name ${id}`,
      summary: "Summary.",
      project_url: `https://github.com/owner/${id}`,
      ...fields,
    },
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
const hold = (reason: string, scope?: Record<string, unknown>) => ({
  restrictions: [
    {
      id: `${reason}-hold`,
      effect: "hold",
      operations: ["download"],
      reason,
      ...(scope ? { scope } : {}),
    },
  ],
});
const packages = (...platforms: string[]) => ({ availability: "packages", platforms });

function fixture(): RouteFitInputs {
  const records = [
    listing("managed-port"),
    listing("prepared-route", packages("windows-x86-64")),
    listing("never-seen-by-code", packages("linux-x86-64", "windows-x86-64")),
    listing("unknown-github", { availability: "unknown", platforms: ["windows-x86-64"] }),
    listing("gitlab-packages", {
      ...packages("windows-x86-64"),
      project_url: "https://gitlab.com/group/project",
    }),
    listing("android-only", packages()),
    listing("other-host", { project_url: "https://example.org/game" }),
    listing("source-only", { availability: "source-only", platforms: ["windows-x86-64"] }),
    listing("held", { ...packages("windows-x86-64"), ...hold("bundled-game-data") }),
    listing("scoped-hold", {
      ...packages("windows-x86-64"),
      ...hold("package-facts-unresolved", { platforms: ["linux-x86-64"] }),
    }),
    // Neither the id, the name nor the project names the engine; only the runtime does.
    listing("adventure-classic", {
      ...packages("windows-x86-64"),
      name: "Classic Adventure",
      project_url: "https://github.com/someone/classic-adventure",
      ...runtime("https://github.com/ScummVM/scummvm.git"),
    }),
    // A name that mentions ScummVM but runs another engine is not excluded.
    listing("scummvm-named-elsewhere", {
      ...packages("windows-x86-64"),
      name: "Not ScummVM",
      ...runtime("https://github.com/other/engine"),
    }),
  ];
  const ports = [
    { id: "managed-port", adapter: "native-portable", release: { repository: "owner/managed" } },
  ] as CatalogPort[];
  return {
    records,
    ports,
    packageShapes: { entries: [{ port_id: "managed-port" }] },
    routeEnrollment: { cases: [{ port_id: "prepared-route" }] },
  };
}

void test("classifies every disposition from data alone", () => {
  const inputs = fixture();
  const report = routeFitReport(inputs);
  checkRouteFitReport(report, inputs.records);
  const fit = Object.fromEntries(
    report.identities.map((identity) => [identity.id, identity.disposition]),
  );
  assert.deepEqual(fit, {
    "adventure-classic": "excluded-scummvm",
    "android-only": "missing-capability",
    "gitlab-packages": "needs-admission",
    held: "upstream-condition",
    "managed-port": "enrolled",
    "never-seen-by-code": "data-only",
    "other-host": "missing-capability",
    "prepared-route": "enrolled",
    "scoped-hold": "data-only",
    "scummvm-named-elsewhere": "data-only",
    "source-only": "upstream-condition",
    "unknown-github": "needs-bytes-worker",
  });
  for (const name of dispositions)
    assert.ok(report.summary.by_disposition[name] > 0, `${name} is covered`);
  assert.deepEqual(report.identities.at(-1)?.family, {
    adapter: "listing",
    provider: "github",
  });
  const managed = report.identities.find((identity) => identity.id === "managed-port")!;
  assert.deepEqual(managed.family, { adapter: "native-portable", provider: "github" });
  assert.match(managed.reason, /1 reviewed package shape/u);
  assert.match(
    report.identities.find((identity) => identity.id === "held")!.reason,
    /bundled-game-data/u,
  );
  assert.equal(report.summary.listing_only_github_packages_windows_x86_64, 6);
  assert.equal(report.summary.data_only_windows_x86_64, 3);
  assert.equal(report.summary.by_family["listing/gitlab"], 1);
  assert.equal(report.summary.by_family["listing/other"], 1);
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

void test("only successful observations add package evidence", () => {
  const inputs = fixture();
  const observation = (status?: string) => ({
    provider: "github",
    repository: "owner/unknown-github",
    ...(status ? { status } : {}),
    releases: [{ assets: [{ name: "game-win64.zip", platform_hints: ["windows-x86-64"] }] }],
  });
  const fit = (status?: string) =>
    routeFitReport({
      ...inputs,
      observerReport: {
        listings: [{ id: "unknown-github", upstream_observation: observation(status) }],
      },
    }).identities.find((identity) => identity.id === "unknown-github")!;
  assert.equal(fit().disposition, "data-only");
  assert.match(fit().reason, /observed for windows-x86-64/u);
  for (const status of ["incomplete", "unavailable", "failed"])
    assert.equal(fit(status).disposition, "needs-bytes-worker");
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
    const empty = join(directory, "observations.json");
    writeFileSync(empty, "[]");
    assert.match(main(["--observations", empty], root), /Catalog route fit: \d+ identities/u);
    assert.throws(() => main(["--unknown"], root), /Usage/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

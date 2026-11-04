import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, copyFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  checkedAuthoredPort,
  readCatalogSource,
  projectAuthoredPort,
} from "./catalog-authoring.mts";
import {
  projectRouteFacts,
  registrationOwnership,
  managedOwnership,
  routeEnrollment,
  renderRouteTests,
} from "./catalog-route-facts.mts";
import { isRecord } from "./runtime-values.mts";
const catalogRoot = resolve("crates/portcove-core/catalog");
const ids = ["mstan-tetrisgbrecomp", "n64hub-super-mario-64-recomp", "doom-3-classic-dhewm3"];
function input(id: string) {
  return checkedAuthoredPort(
    JSON.parse(readFileSync(join(catalogRoot, "ports", `${id}.json`), "utf8")),
  );
}
function guide(value: ReturnType<typeof projectRouteFacts>) {
  const result = value.listing.manual_setup;
  assert.ok(
    isRecord(result) &&
      Array.isArray(result.steps) &&
      Array.isArray(result.references) &&
      Array.isArray(result.warnings),
  );
  return {
    steps: result.steps as unknown[],
    references: result.references as unknown[],
    warnings: result.warnings as unknown[],
  };
}
for (const id of ids)
  void test(`route facts project concrete current and retained-readable guide: ${id}`, () => {
    const raw = input(id),
      before = JSON.stringify(raw),
      output = projectRouteFacts(raw),
      rendered = guide(output);
    assert.equal(JSON.stringify(raw), before, "projection cannot mutate creating input");
    assert.ok(
      rendered.references.some(
        (reference) => isRecord(reference) && reference.instruction === registrationOwnership,
      ),
    );
    assert.ok(
      rendered.steps.some(
        (step) =>
          isRecord(step) &&
          String(step.instruction).includes(
            routeEnrollment([raw]).cases[0]!.prepared_player.executable,
          ),
      ),
    );
    assert.equal(
      "route_facts_v1" in (projectAuthoredPort(raw) ?? {}),
      false,
      "authoring facts do not become operational authority",
    );
    if (raw.integration) {
      assert.ok(
        String(
          (projectAuthoredPort(raw)!.presentation as Record<string, unknown>).manual_preparation,
        ).includes(managedOwnership),
      );
      assert.ok(
        rendered.warnings.some((warning) => String(warning).includes("short library path")),
      );
      assert.ok(
        rendered.steps.some(
          (step) => isRecord(step) && String(step.instruction).includes("pak000.pk4"),
        ),
        "required original preparation remains an action",
      );
    } else
      assert.deepEqual(
        rendered.warnings,
        (raw.listing.manual_setup as Record<string, unknown>).warnings,
        "bespoke warnings stay visible",
      );
  });
void test("unknown, conflicting and unbounded route facts refuse before projection", () => {
  const object = (value: unknown) => {
    assert.ok(isRecord(value));
    return value;
  };
  for (const mutate of [
    (facts: Record<string, unknown>) =>
      (object(facts.prepared_player).executable = "../foreign.exe"),
    (facts: Record<string, unknown>) =>
      (object(facts.prepared_player).working_directory = "arbitrary-script"),
    (facts: Record<string, unknown>) => (object(facts.prepared_player).execute = true),
    (facts: Record<string, unknown>) =>
      (object(facts.prepared_player).arguments = ["x".repeat(5000)]),
    (facts: Record<string, unknown>) => (facts.format_version = 2),
    (facts: Record<string, unknown>) =>
      (facts.managed_native = { preparation: { title: "x", instruction: "x" }, warnings: [] }),
  ]) {
    const raw = structuredClone(input(ids[0]!));
    mutate(object(raw.route_facts_v1));
    assert.throws(() => checkedAuthoredPort(raw));
  }
  const raw = structuredClone(input(ids[2]!));
  raw.route_facts_v1!.prepared_player.executable = "unrelated.exe";
  assert.throws(() => checkedAuthoredPort(raw), /disagree/);
});
void test("one shared explanation edit reaches every declared route; historical concrete guides stay exact", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "portcove-route-explanation-"));
  copyFileSync(resolve("scripts/runtime-values.mts"), join(scratch, "runtime-values.mts"));
  const before = readFileSync(resolve("scripts/catalog-route-facts.mts"), "utf8");
  const replacement =
    "Removing this registration keeps all external runtime and player-data files in place.";
  const original = "Removing this registration preserves every external file.";
  assert.equal(before.split(original).length, 2);
  writeFileSync(join(scratch, "catalog-route-facts.mts"), before.replace(original, replacement));
  const changed = (await import(
    pathToFileURL(join(scratch, "catalog-route-facts.mts")).href
  )) as typeof import("./catalog-route-facts.mts");
  for (const id of ids) {
    const raw = input(id),
      retained = JSON.stringify(projectRouteFacts(raw));
    const next = guide(changed.projectRouteFacts(raw));
    assert.ok(
      next.references.some(
        (reference) => isRecord(reference) && String(reference.instruction).includes(replacement),
      ),
      id,
    );
    assert.equal(
      JSON.stringify(projectRouteFacts(raw)),
      retained,
      "old concrete output remains independently reproducible",
    );
  }
});
void test("generated enrollment matches every declaration exactly once and uses stable IDs", () => {
  const source = readCatalogSource(catalogRoot),
    generated = routeEnrollment(source.records);
  assert.deepEqual(
    JSON.parse(readFileSync(join(catalogRoot, "route-enrollment.generated.json"), "utf8")),
    generated,
  );
  assert.deepEqual(
    new Set(generated.cases.map((row) => row.port_id)),
    new Set(
      source.records.filter((row) => row.route_facts_v1 !== undefined).map((row) => row.listing.id),
    ),
  );
  assert.equal(generated.cases.length, new Set(generated.cases.map((row) => row.port_id)).size);
  for (const id of ids) assert.ok(generated.cases.some((row) => row.port_id === id));
  const legacy = source.records.find((row) => row.route_facts_v1 === undefined)!;
  assert.equal(
    projectRouteFacts(legacy),
    legacy,
    "legacy concrete guides retain exact interpretation",
  );
});

void test("literal argument presentation preserves empty vectors, boundaries and delimiter characters", () => {
  const raw = input("mstan-tetrisgbrecomp");
  const arguments_ = ["a; b", "literal spaces", 'quote"and\\backslash'];
  raw.route_facts_v1!.prepared_player.arguments = arguments_;
  const rendered = guide(projectRouteFacts(raw));
  assert.ok(
    rendered.steps.some(
      (step) => isRecord(step) && String(step.instruction).includes(JSON.stringify(arguments_)),
    ),
  );
});

void test("ordinary declarations generate distinct bounded title tests without authored Rust", () => {
  const source = readCatalogSource(catalogRoot);
  const rendered = renderRouteTests(source.records);
  for (const kind of ["prepared", "managed"] as const) {
    assert.equal(
      readFileSync(
        resolve(`crates/portcove-core/src/testdata/${kind}-route-tests.generated.rs`),
        "utf8",
      ),
      rendered[kind],
    );
    const rows = routeEnrollment(source.records).cases.filter(
      (row) => row.managed_native === (kind === "managed"),
    );
    assert.equal(rendered[kind].match(/#\[(?:tokio::)?test\]/gu)?.length ?? 0, rows.length);
    for (const row of rows) assert.ok(rendered[kind].includes(`(${JSON.stringify(row.port_id)})`));
  }
  const fresh = structuredClone(input("mstan-tetrisgbrecomp"));
  fresh.listing.id = "another-fitting-player";
  const next = renderRouteTests([...source.records, fresh]);
  assert.ok(next.prepared.includes("fn prepared_guide_adoption_declared_another_fitting_player()"));
  assert.ok(
    next.prepared.includes('assert_declarative_prepared_player_route("another-fitting-player");'),
  );
  assert.equal(next.managed, rendered.managed);
  assert.throws(() => renderRouteTests([fresh, fresh]), /Duplicate/);
  fresh.listing.id = 'unsafe");panic!("injected';
  assert.throws(() => renderRouteTests([fresh]), /safe literals/);
});

void test("expanded route guides refuse the retained concrete entry bound before output", () => {
  const raw = structuredClone(input(ids[0]!));
  const setup = raw.listing.manual_setup;
  assert.ok(isRecord(setup) && Array.isArray(setup.steps));
  setup.steps = Array.from({ length: 8 }, (_, index) => ({
    title: `Distinct instruction ${index}`,
    instruction: "Keep a genuine title requirement.",
  }));
  assert.throws(() => projectRouteFacts(raw), /Expanded route guide exceeds/);
});

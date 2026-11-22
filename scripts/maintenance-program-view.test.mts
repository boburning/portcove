import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { AuthoredPort, CatalogPort } from "./catalog-authoring.mts";
import { routeFitReport, type RouteFitInputs } from "./catalog-route-fit.mts";
import { handoffRegistry } from "./maintenance-handoffs.mts";
import {
  authorityInventoryErrors,
  authorityKinds,
  checkProgramView,
  detectAuthorities,
  main,
  programView,
  serializeProgramView,
  withoutTestItems,
  type AuthorityKind,
  type AuthorityReport,
} from "./maintenance-program-view.mts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

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
const scummvm = {
  implementation: {
    format_version: 1,
    methods: [{ kind: "engine-reimplementation", evidence_urls: [] }],
    dependencies: [
      {
        kind: "runtime",
        project_url: "https://github.com/scummvm/scummvm",
        name: "Engine",
        confidence: "confirmed",
        evidence_urls: [],
      },
    ],
  },
};

/** Route-fit inputs: two operational definitions, listing-only records and a ScummVM title. */
function routeFitInputs(observed = false): RouteFitInputs {
  const records = [
    listing("data-port"),
    listing("coded-port"),
    listing("never-seen-by-code", {
      availability: "packages",
      platforms: ["windows-x86-64"],
    }),
    listing("adventure-classic", { availability: "packages", ...scummvm }),
    listing(
      "pending-github",
      observed
        ? { availability: "source-only", platforms: ["windows-x86-64"] }
        : { availability: "unknown" },
    ),
  ];
  const ports = [
    {
      id: "data-port",
      adapter: "native-portable",
      release: { repository: "owner/data" },
    },
    {
      id: "coded-port",
      adapter: "native-portable",
      release: { repository: "Owner/Coded" },
      external_profile_policy: "coded-desktop-v1",
    },
  ] as CatalogPort[];
  return {
    records,
    ports,
    packageShapes: { entries: [] },
    routeEnrollment: { cases: [] },
  };
}

function write(root: string, path: string, text: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

/** A repository tree carrying one instance of each authority shape. */
function authorityTree(withCode: boolean) {
  const root = mkdtempSync(join(tmpdir(), "portcove-program-view-"));
  const src = "crates/portcove-core/src";
  write(
    root,
    `${src}/types.rs`,
    [
      '#[serde(rename_all = "kebab-case")]',
      "pub enum ExternalProfilePolicy {",
      withCode ? "    CodedDesktopV1," : "",
      "}",
      "pub enum ManagedInitialization {",
      '    #[serde(rename = "unused-recipe-v1")]',
      "    UnusedRecipeV1,",
      "}",
      "pub enum RuntimeDataPolicy {",
      "    Unused,",
      "}",
      "pub enum PreparedRuntimeSettingsContract {",
      "    Unused,",
      "}",
      "pub enum PreparedSharedPreferencesContract {",
      "    Unused,",
      "}",
    ].join("\n"),
  );
  write(root, `${src}/native_external_profile/coded.rs`, "pub fn resolve() {}\n");
  write(
    root,
    `${src}/provider.rs`,
    [
      'const GAME_BINDINGS: &[(&str, u64)] = &[("listing-only-id", 1)];',
      withCode ? 'fn special(id: &str) -> bool { id == "coded-port" }' : "",
      "#[cfg(test)]",
      "mod tests {",
      '    const FIXTURE: &str = "data-port";',
      "}",
    ].join("\n"),
  );
  write(root, `${src}/provider_tests.rs`, 'const ID: &str = "data-port";\n');
  write(
    root,
    `${src}/github_mods.rs`,
    'const SOURCES: &[ReviewedSource] = &[ReviewedSource {\n    runtime_repository: "Other/Runtime",\n    game: "x",\n}];\n',
  );
  write(
    root,
    "scripts/catalog-coded-family.mts",
    withCode ? 'const repository = "owner/coded";\n' : "export {};\n",
  );
  write(root, "scripts/catalog-coded-family.test.mts", 'const id = "data-port";\n');
  write(
    root,
    "crates/portcove-core/catalog/external-mod-portals.json",
    JSON.stringify([{ port: "never-seen-by-code", portals: ["portal"] }]),
  );
  return root;
}

const codeKinds = new Set([
  "core-title-literal",
  "external-profile-policy",
  "family-generator-script",
]);

function viewFor(options: { withCode: boolean; observed?: boolean; observerReport?: unknown }) {
  const inputs = routeFitInputs(options.observed);
  const routeFit = routeFitReport(inputs);
  const root = authorityTree(options.withCode);
  try {
    // Without title code the fixture declares those kinds retired, as main would.
    const kinds = authorityKinds.map((kind) => ({
      ...kind,
      retired: !options.withCode && codeKinds.has(kind.kind),
    }));
    const authorities = detectAuthorities(
      root,
      {
        ids: new Set(routeFit.identities.map((identity) => identity.id)),
        ports: inputs.ports,
      },
      kinds,
    );
    const view = programView({
      routeFit,
      authorities,
      ...(options.observerReport === undefined ? {} : { observerReport: options.observerReport }),
    });
    checkProgramView(view, routeFit);
    return view;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const subject = (view: ReturnType<typeof programView>, id: string) =>
  view.subjects.find((entry) => entry.id === id)!;

void test("the fitting gate counts in-scope identities with a determined disposition", () => {
  const failing = viewFor({ withCode: false });
  assert.equal(failing.gates.fitting.denominator.count, 4);
  assert.equal(failing.gates.fitting.denominator.version, "program-view/in-scope/1");
  assert.equal(failing.gates.fitting.numerator, 3);
  assert.equal(failing.gates.fitting.passed, false);
  assert.deepEqual(
    failing.gates.fitting.failing.map((entry) => entry.id),
    ["pending-github"],
  );
  assert.equal(subject(failing, "pending-github").remaining_action, "observation");

  const passing = viewFor({ withCode: false, observed: true });
  assert.equal(passing.gates.fitting.passed, true);
  assert.equal(passing.gates.fitting.ratio, 1);
  assert.deepEqual(passing.gates.fitting.failing, []);
  assert.equal(subject(passing, "pending-github").remaining_action, "upstream-condition");
});

void test("the retired-authority gate is derived from detected title-specific code", () => {
  const failing = viewFor({ withCode: true });
  const gate = failing.gates.retired_authority;
  assert.equal(gate.denominator.version, "program-view/in-scope-enrolled/1");
  assert.equal(gate.denominator.count, 2);
  assert.equal(gate.numerator, 1);
  assert.equal(gate.passed, false);
  assert.deepEqual(gate.failing, [
    {
      id: "coded-port",
      detail: "Served by core-title-literal, external-profile-policy, family-generator-script.",
    },
  ]);
  assert.equal(subject(failing, "coded-port").remaining_action, "retire-title-authority");
  assert.equal(subject(failing, "data-port").remaining_action, "none");
  assert.deepEqual(subject(failing, "data-port").title_code_paths, []);

  const passing = viewFor({ withCode: false }).gates.retired_authority;
  assert.equal(passing.passed, true);
  assert.equal(passing.numerator, 2);
  assert.equal(passing.ratio, 1);
});

void test("test modules and test files never count as title-specific code", () => {
  const view = viewFor({ withCode: false });
  const literal = view.authority_kinds.find((kind) => kind.kind === "core-title-literal")!;
  assert.equal(literal.state, "retired");
  assert.deepEqual(literal.identities, []);
  assert.equal(withoutTestItems('a\n#[cfg(test)]\nmod tests { fn f() { "x" } }\nb'), "a\n\nb");
  assert.equal(withoutTestItems("#[cfg(test)]\nmod fixtures;\nc"), "\nc");
  const generator = view.authority_kinds.find((kind) => kind.kind === "family-generator-script")!;
  assert.deepEqual(generator.files, []);
});

void test("an identity no code has seen is a subject with its route-fit disposition", () => {
  const view = viewFor({ withCode: true });
  const unseen = subject(view, "never-seen-by-code");
  assert.equal(unseen.scope, "in-scope");
  assert.equal(unseen.disposition, "needs-bytes-worker");
  assert.equal(unseen.remaining_action, "bytes-worker");
  // A listing-only identity bound in a portal file still reports the path.
  assert.deepEqual(unseen.title_code_paths, ["external-mod-portals"]);
  assert.ok(unseen.reason.length > 0);
});

void test("ScummVM-engine identities are deferred and excluded from both denominators", () => {
  const view = viewFor({ withCode: true });
  const deferred = subject(view, "adventure-classic");
  assert.equal(deferred.scope, "deferred-scummvm");
  assert.equal(deferred.disposition, "excluded-scummvm");
  assert.equal(deferred.remaining_action, "owner-decision");
  assert.equal(view.metrics.by_disposition.denominator.count, 5);
  assert.equal(view.gates.fitting.denominator.count, 4);
  assert.ok(!view.gates.fitting.failing.some((entry) => entry.id === "adventure-classic"));
  assert.equal(view.gates.retired_authority.denominator.count, 2);
  assert.equal(view.remaining_actions.counts["owner-decision"], 1);
});

void test("observer coverage is unknown without a report and counted with one", () => {
  const absent = viewFor({ withCode: false });
  assert.equal(absent.inputs.observer_report, "absent");
  assert.equal(absent.metrics.observer_coverage.state, "unknown");
  assert.ok(!("by_state" in absent.metrics.observer_coverage));

  const reported = viewFor({
    withCode: false,
    observerReport: {
      source_statuses: [
        { source_key: "a", current_scope_complete: true },
        { source_key: "b", current_scope_complete: false },
        {
          source_key: "c",
          current_scope_complete: false,
          coverage: { kind: "partial" },
        },
        {
          source_key: "d",
          current_scope_complete: false,
          coverage: { kind: "unavailable" },
        },
        {
          source_key: "e",
          current_scope_complete: false,
          coverage: { kind: "failed" },
        },
      ],
    },
  });
  assert.deepEqual(reported.metrics.observer_coverage, {
    state: "reported",
    denominator: {
      version: "program-view/observer-sources/1",
      definition: "source_statuses entries of the supplied catalog upstream observer report.",
      count: 5,
    },
    by_state: {
      complete: 1,
      pending: 1,
      partial: 1,
      unavailable: 1,
      failed: 1,
    },
  });
  assert.throws(() => viewFor({ withCode: false, observerReport: { listings: [] } }), {
    message: /source_statuses/u,
  });
});

void test("metrics carry versioned denominators and the handoff dispatch state", () => {
  const view = viewFor({ withCode: true });
  assert.equal(view.metrics.by_disposition.counts.enrolled, 2);
  assert.equal(view.metrics.by_family.counts["native-portable/github"], 2);
  assert.equal(view.metrics.handoff_classes.denominator.count, handoffRegistry.length);
  assert.deepEqual(view.metrics.handoff_classes.dispatch, {
    disabled: handoffRegistry.length,
  });
  assert.ok(view.metrics.handoff_classes.classes.every((entry) => entry.contract));
  const total = Object.values(view.remaining_actions.counts).reduce((sum, count) => sum + count);
  assert.equal(total, view.remaining_actions.denominator.count);
  assert.equal(view.authority, "derived-read-only-projection");
});

void test("the view is deterministic: two runs are byte-identical", () => {
  assert.equal(
    serializeProgramView(viewFor({ withCode: true })),
    serializeProgramView(viewFor({ withCode: true })),
  );
  const first = main(["--json"], repositoryRoot);
  assert.equal(main(["--json", "--check"], repositoryRoot), first);
  assert.doesNotMatch(first, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u);
});

void test("an authority detector that matches nothing must be declared retired", () => {
  const root = mkdtempSync(join(tmpdir(), "portcove-program-view-empty-"));
  try {
    const context = { ids: new Set(["x"]), ports: [] };
    const errors = authorityInventoryErrors(detectAuthorities(root, context));
    assert.equal(errors.length, authorityKinds.length);
    assert.match(errors[0]!, /found nothing .* not declared retired/u);

    const retired: AuthorityKind[] = authorityKinds.map((kind) => ({
      ...kind,
      retired: true,
    }));
    assert.deepEqual(authorityInventoryErrors(detectAuthorities(root, context, retired)), []);
    const reports = detectAuthorities(root, context, retired);
    assert.ok(reports.every((report) => report.state === "retired" && report.count === 0));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const stillMatching: AuthorityReport = {
    kind: "kind",
    description: "",
    detector: "",
    state: "active",
    declared_retired: true,
    count: 1,
    files: ["file"],
    identities: [],
  };
  assert.match(authorityInventoryErrors([stillMatching])[0]!, /declared retired but/u);
  assert.throws(
    () =>
      programView({
        routeFit: routeFitReport(routeFitInputs()),
        authorities: [{ ...stillMatching, declared_retired: false, state: "retired" }],
      }),
    { message: /not declared retired/u },
  );
});

void test("every declared authority kind still matches the committed repository", () => {
  const view = JSON.parse(main(["--json"], repositoryRoot)) as ReturnType<typeof programView>;
  assert.deepEqual(
    authorityInventoryErrors(view.authority_kinds),
    [],
    "A detector found nothing: fix its pattern or declare the kind retired.",
  );
  assert.equal(view.authority_kinds.length, authorityKinds.length);
  const covered = new Set(view.authority_kinds.flatMap((kind) => kind.identities ?? []));
  const ids = new Set(view.subjects.map((entry) => entry.id));
  for (const id of covered) assert.ok(ids.has(id), `${id} is not a catalog identity`);
  assert.equal(
    view.gates.fitting.denominator.count,
    view.subjects.filter((entry) => entry.scope === "in-scope").length,
  );
});

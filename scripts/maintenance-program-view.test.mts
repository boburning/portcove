import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { AuthoredPort, CatalogPort } from "./catalog-authoring.mts";
import { routeFitReport, type RouteFitInputs } from "./catalog-route-fit.mts";
import { handoffRegistry } from "./maintenance-handoffs.mts";
import { readFileSync } from "node:fs";
import {
  authorityCoverage,
  authorityInventoryErrors,
  authorityKinds,
  cfgClass,
  checkProgramView,
  detectAuthorities,
  main,
  parseEnum,
  partitionCfgItems,
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

const src = "crates/portcove-core/src";
const historicalDigest = "a".repeat(64);

/** A repository tree carrying one instance of each authority shape. */
function authorityTree(withCode: boolean, extra: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "portcove-program-view-"));
  write(
    root,
    `${src}/types.rs`,
    [
      ...(withCode
        ? [
            '#[serde(rename_all = "kebab-case")]',
            "pub enum ExternalProfilePolicy {",
            "    CodedDesktopV1,",
            "}",
          ]
        : []),
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
  if (withCode) {
    write(
      root,
      `${src}/native_external_profile/coded.rs`,
      "pub fn resolve(policy: ExternalProfilePolicy) {}\n",
    );
    write(root, `${src}/coded_port_recovery.rs`, "pub fn recover() {}\n");
  }
  write(
    root,
    `${src}/provider.rs`,
    [
      'const GAMEBANANA_BINDINGS: &[(&str, u64)] = &[("never-seen-by-code", 1)];',
      'const COMMUNITY_BINDINGS: &[(&str, &str)] = &[("never-seen-by-code", "x")];',
      withCode ? 'fn special(id: &str) -> bool { id == "coded-port" }' : "",
      withCode ? '#[cfg(any(test, feature = "qualification-fixtures"))]' : "",
      withCode ? 'const QUALIFIED: &str = "coded-port";' : "",
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
  // Each historical section names its subject a different way: an explicit
  // identity, an exact package digest bound by a port-scoped source contract,
  // the catalog release repository or the title keys its text spells.
  write(
    root,
    `${src}/historical-artifacts.json`,
    JSON.stringify({
      dkr: [{ version: "1", executable: "Never-Seen-By-Code.exe" }],
      direct: [{ port_id: withCode ? "coded-port" : "never-seen-by-code", version: "1" }],
      packages: [{ contract: "frozen-v1", version: "1", sha256: historicalDigest }],
      cartridge: [{ port_id: "never-seen-by-code", projection: "never-seen-by-code" }],
      forbidden_memories_producer: withCode
        ? { repository: "owner/coded", tag: "v1" }
        : { asset_name: "never-seen-by-code-win.zip", tag: "v1" },
    }),
  );
  write(
    root,
    "crates/portcove-core/catalog/catalog.json",
    JSON.stringify({
      source_catalog: {
        qualification: [
          { scope: { port_id: "never-seen-by-code", artifact_sha256: historicalDigest } },
        ],
      },
    }),
  );
  write(
    root,
    "crates/portcove-core/catalog/tool-artifacts.json",
    JSON.stringify([{ name: "builder-pack.zip", sha256: "b".repeat(64) }]),
  );
  for (const [path, text] of Object.entries(extra)) write(root, path, text);
  return root;
}

const codeKinds = new Set([
  "external-profile-policy",
  "family-generator-script",
  "native-external-profile-module",
  "qualification-fixture-title-code",
  "title-named-core-item",
]);
/** Kinds the small fixture catalog gives no consumer. */
const consumerless = new Set([
  "github-mod-source-table",
  "managed-initialization",
  "prepared-shared-preferences-contract",
  "runtime-data-policy",
]);

/** The inventory as main would declare it for the fixture tree. */
function fixtureKinds(withCode: boolean): AuthorityKind[] {
  return authorityKinds.map((kind) => {
    const retired = !withCode && codeKinds.has(kind.kind);
    return {
      ...kind,
      retired,
      ...(kind.members ? { members: kind.members.map((member) => ({ ...member, retired })) } : {}),
      ...(consumerless.has(kind.kind) ? { no_catalog_consumer: "Fixture catalog." } : {}),
    };
  });
}

function fixtureContext(inputs: RouteFitInputs) {
  const routeFit = routeFitReport(inputs);
  return {
    routeFit,
    context: {
      ids: new Set(routeFit.identities.map((identity) => identity.id)),
      ports: inputs.ports,
      listings: inputs.records,
    },
  };
}

function viewFor(options: {
  withCode: boolean;
  observed?: boolean;
  observerReport?: unknown;
  extra?: Record<string, string>;
}) {
  const inputs = routeFitInputs(options.observed);
  const { routeFit, context } = fixtureContext(inputs);
  const root = authorityTree(options.withCode, options.extra);
  try {
    const authorities = detectAuthorities(root, context, fixtureKinds(options.withCode));
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
      detail:
        "Served by core-title-literal, external-profile-policy, family-generator-script, historical-artifact-registry, native-external-profile-module, qualification-fixture-title-code, title-named-core-item.",
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
  // Only the binding table's production literal counts; the test module's does not.
  assert.deepEqual(literal.identities, ["never-seen-by-code"]);
  assert.equal(withoutTestItems('a\n#[cfg(test)]\nmod tests { fn f() { "x" } }\nb'), "a\n\nb");
  assert.equal(withoutTestItems("#[cfg(test)]\nmod fixtures;\nc"), "\nc");
  const generator = view.authority_kinds.find((kind) => kind.kind === "family-generator-script")!;
  assert.deepEqual(generator.files, []);
});

void test("historical artifact rows are covered identities, never a silent retirement", () => {
  const registry = (view: ReturnType<typeof programView>) =>
    view.authority_kinds.find((kind) => kind.kind === "historical-artifact-registry")!;
  const coded = registry(viewFor({ withCode: true }));
  // An explicit identity and the catalog release repository both name coded-port.
  assert.deepEqual(coded.identities, ["coded-port", "never-seen-by-code"]);
  assert.deepEqual(coded.unattributed, []);
  assert.equal(coded.count, 6);
  assert.deepEqual(
    coded.members?.map((member) => [member.name, member.rows]),
    [
      ["historical-artifacts.json#dkr", 1],
      ["historical-artifacts.json#direct", 1],
      ["historical-artifacts.json#packages", 1],
      ["historical-artifacts.json#cartridge", 1],
      ["historical-artifacts.json#forbidden_memories_producer", 1],
      ["tool-artifacts.json", 1],
    ],
  );
  // Digest, title-key and identity rows all name the listing-only subject.
  const data = registry(viewFor({ withCode: false }));
  assert.deepEqual(data.identities, ["never-seen-by-code"]);
  assert.deepEqual(data.unattributed, []);

  // A title row that names no subject makes the gate unknown rather than
  // passing; an unmatched builder pack row names no title at all.
  const unnamed = viewFor({
    withCode: false,
    extra: {
      [`${src}/historical-artifacts.json`]: JSON.stringify({
        dkr: [{ version: "1" }],
        direct: [{ port_id: "never-seen-by-code" }],
        packages: [{ contract: "frozen-v1", sha256: "c".repeat(64) }],
        cartridge: [{ port_id: "never-seen-by-code" }],
        forbidden_memories_producer: { tag: "v1" },
      }),
    },
  });
  assert.deepEqual(registry(unnamed).unattributed, [
    "historical-artifacts.json#dkr[0]",
    "historical-artifacts.json#forbidden_memories_producer[0]",
    "historical-artifacts.json#packages[0]",
  ]);
  assert.equal(unnamed.gates.retired_authority.state, "unknown");
  assert.deepEqual(
    unnamed.gates.retired_authority.unknown_kinds.map((entry) => entry.kind),
    ["historical-artifact-registry"],
  );

  // A missing section is reported by the rot check, not read as retired.
  const root = authorityTree(false, {
    [`${src}/historical-artifacts.json`]: JSON.stringify({ direct: [] }),
  });
  try {
    const { context } = fixtureContext(routeFitInputs());
    const errors = authorityInventoryErrors(detectAuthorities(root, context, fixtureKinds(false)));
    assert.ok(
      errors.includes(
        "Authority kind historical-artifact-registry cannot find historical-artifacts.json#dkr; fix the detector or declare that member retired.",
      ),
      errors.join("\n"),
    );
    assert.ok(
      errors.includes(
        "Authority kind historical-artifact-registry found historical-artifacts.json#direct but read no rows from it.",
      ),
      errors.join("\n"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("an identity no code has seen is a subject with its route-fit disposition", () => {
  const view = viewFor({ withCode: true });
  const unseen = subject(view, "never-seen-by-code");
  assert.equal(unseen.scope, "in-scope");
  assert.equal(unseen.disposition, "needs-bytes-worker");
  assert.equal(unseen.remaining_action, "bytes-worker");
  // A listing-only identity bound in a portal file still reports the path.
  assert.deepEqual(unseen.title_code_paths, [
    "core-title-literal",
    "external-mod-portals",
    "historical-artifact-registry",
    "provider-binding-table",
  ]);
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
    for (const kind of authorityKinds.filter((kind) => !kind.retired))
      assert.ok(
        errors.some((error) =>
          new RegExp(
            `^Authority kind ${kind.kind} found nothing .* not declared retired`,
            "u",
          ).test(error),
        ),
        kind.kind,
      );
    // Each declared member that is missing is reported on its own.
    assert.ok(
      errors.includes(
        "Authority kind provider-binding-table cannot find GAMEBANANA_BINDINGS; fix the detector or declare that member retired.",
      ),
    );

    // A kind declared retired stays quiet while its detector finds nothing.
    for (const kind of authorityKinds.filter((kind) => kind.retired))
      assert.ok(
        !errors.some((error) => error.startsWith(`Authority kind ${kind.kind} `)),
        kind.kind,
      );

    const retired: AuthorityKind[] = authorityKinds.map((kind) => ({
      ...kind,
      retired: true,
      ...(kind.members
        ? { members: kind.members.map((member) => ({ ...member, retired: true })) }
        : {}),
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
    identities: ["x"],
    unattributed: [],
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

const report = (fields: Partial<AuthorityReport> & { kind: string }): AuthorityReport => ({
  description: "",
  detector: "",
  state: "active",
  declared_retired: false,
  count: 1,
  files: ["file"],
  identities: [],
  unattributed: [],
  ...fields,
});

void test("a kind that cannot derive identities takes them from its covering kind", () => {
  const routeFit = routeFitReport(routeFitInputs());
  const view = programView({
    routeFit,
    authorities: [
      report({ kind: "enum", identities: ["coded-port"] }),
      report({ kind: "modules", identities: null, covered_through: "enum" }),
    ],
  });
  const gate = view.gates.retired_authority;
  assert.equal(gate.state, "failed");
  assert.deepEqual(gate.unknown_kinds, []);
  assert.deepEqual(gate.unknown, []);
  assert.deepEqual(subject(view, "coded-port").title_code_paths, ["enum", "modules"]);
  assert.equal(subject(view, "data-port").remaining_action, "none");
  assert.equal(gate.numerator, 1);
});

void test("unknown coverage never counts as retired", () => {
  const routeFit = routeFitReport(routeFitInputs());
  const cases: AuthorityReport[][] = [
    // Not derivable and no covering kind.
    [report({ kind: "modules", identities: null })],
    // A covering kind that is itself not derivable.
    [
      report({ kind: "enum", identities: null }),
      report({ kind: "modules", identities: null, covered_through: "enum" }),
    ],
    // A detector that matched entries it cannot attribute.
    [
      report({
        kind: "modules",
        identities: null,
        covered_through: "enum",
        unattributed: ["x.rs"],
      }),
      report({ kind: "enum", identities: ["coded-port"] }),
    ],
  ];
  for (const authorities of cases) {
    const view = programView({ routeFit, authorities });
    const gate = view.gates.retired_authority;
    assert.equal(gate.passed, false);
    assert.ok(gate.state === "unknown" || gate.state === "failed");
    assert.ok(gate.unknown_kinds.some((entry) => entry.kind === "modules"));
    assert.ok(gate.unknown.some((entry) => entry.id === "data-port"));
    assert.ok(!gate.unknown.some((entry) => gate.failing.some((fail) => fail.id === entry.id)));
    assert.equal(gate.numerator, 0);
    assert.equal(subject(view, "data-port").remaining_action, "resolve-authority-inventory");
  }
  const only = programView({ routeFit, authorities: cases[0]! }).gates.retired_authority;
  assert.equal(only.state, "unknown");
  assert.deepEqual(
    only.unknown.map((entry) => entry.id),
    ["coded-port", "data-port"],
  );
  // Retired kinds never make coverage unknown.
  const { unknownKinds } = authorityCoverage([
    report({ kind: "modules", identities: null, state: "retired", declared_retired: true }),
  ]);
  assert.deepEqual(unknownKinds, []);
});

void test("a native profile module not keyed on the policy enum makes coverage unknown", () => {
  const view = viewFor({
    withCode: true,
    extra: { [`${src}/native_external_profile/other.rs`]: "pub fn resolve() {}\n" },
  });
  const modules = view.authority_kinds.find(
    (kind) => kind.kind === "native-external-profile-module",
  )!;
  assert.deepEqual(modules.unattributed, [`${src}/native_external_profile/other.rs`]);
  const gate = view.gates.retired_authority;
  assert.equal(gate.passed, false);
  assert.deepEqual(
    gate.unknown_kinds.map((entry) => entry.kind),
    ["native-external-profile-module"],
  );
  assert.deepEqual(
    gate.unknown.map((entry) => entry.id),
    ["data-port"],
  );
  assert.equal(gate.numerator, 0);
  // A module the dispatch file keys on the enum is attributed.
  const keyed = viewFor({
    withCode: true,
    extra: {
      [`${src}/native_external_profile/other.rs`]: "pub fn resolve() {}\n",
      [`${src}/native_external_profile.rs`]:
        "ExternalProfilePolicy::CodedDesktopV1 => other::resolve(),\n",
    },
  });
  assert.deepEqual(keyed.gates.retired_authority.unknown_kinds, []);
});

void test("detector rot: an active derivable kind with no identity is an error unless declared", () => {
  assert.match(
    authorityInventoryErrors([report({ kind: "enum", identities: [] })])[0]!,
    /derives no catalog identity/u,
  );
  assert.deepEqual(
    authorityInventoryErrors([
      report({ kind: "enum", identities: [], no_catalog_consumer: "Core selects it." }),
    ]),
    [],
  );
  assert.match(
    authorityInventoryErrors([
      report({ kind: "enum", identities: ["x"], no_catalog_consumer: "Stale." }),
    ])[0]!,
    /declares no catalog consumer but covers 1/u,
  );
  // The fixture's renamed enum serialization drops every identity of an active kind.
  const inputs = routeFitInputs();
  const { context } = fixtureContext(inputs);
  const root = authorityTree(true, {
    [`${src}/types.rs`]: [
      "pub enum ExternalProfilePolicy {",
      '    #[serde(rename = "coded-desktop-v2")]',
      "    CodedDesktopV1,",
      "}",
    ].join("\n"),
  });
  try {
    const errors = authorityInventoryErrors(detectAuthorities(root, context, fixtureKinds(true)));
    assert.ok(
      errors.some((error) =>
        /external-profile-policy matches 1 entries but derives no/u.test(error),
      ),
      errors.join("\n"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("detector rot: enum shapes the detector cannot read fail loudly", () => {
  const enumText = (header: string, body: string) => `${header}\npub enum Policy {\n${body}\n}\n`;
  assert.deepEqual(
    parseEnum(
      enumText(
        '#[serde(rename_all = "kebab-case")]',
        '    /// Doc.\n    #[default]\n    OneTwo,\n    #[serde(rename = "x-y")]\n    Other,',
      ),
      "Policy",
    )?.variants,
    [
      { name: "OneTwo", serialized: "one-two" },
      { name: "Other", serialized: "x-y" },
    ],
  );
  assert.throws(
    () => parseEnum(enumText('#[serde(rename_all = "snake_case")]', "    OneTwo,"), "Policy"),
    { message: /rename_all = "snake_case"/u },
  );
  assert.throws(() => parseEnum(enumText("", "    OneTwo { field: u32 },"), "Policy"), {
    message: /variant shape .* cannot read: OneTwo \{ field: u32 \},/u,
  });
  assert.throws(() => parseEnum(enumText("", "    OneTwo(u32),"), "Policy"), {
    message: /variant shape/u,
  });
  assert.throws(() => parseEnum(enumText("", '    #[serde(alias = "z")]\n    OneTwo,'), "Policy"), {
    message: /attribute .* cannot read/u,
  });
  assert.equal(parseEnum("", "Policy"), undefined);
});

void test("detector rot: each declared table is found or individually retired", () => {
  const inputs = routeFitInputs();
  const { context } = fixtureContext(inputs);
  const root = authorityTree(true, {
    [`${src}/provider.rs`]:
      'const GAMEBANANA_BINDINGS: &[(&str, u64)] = &[("never-seen-by-code", 1)];\nconst RENAMED_BINDINGS: &[(&str, &str)] = &[("never-seen-by-code", "x")];\n',
  });
  try {
    const errors = authorityInventoryErrors(detectAuthorities(root, context, fixtureKinds(true)));
    assert.ok(
      errors.includes(
        "Authority kind provider-binding-table cannot find COMMUNITY_BINDINGS; fix the detector or declare that member retired.",
      ),
    );
    assert.ok(
      errors.includes(
        "Authority kind provider-binding-table found undeclared member RENAMED_BINDINGS; declare it.",
      ),
    );
    const retiredMember = fixtureKinds(true).map((kind) =>
      kind.kind === "provider-binding-table"
        ? {
            ...kind,
            members: [
              { name: "COMMUNITY_BINDINGS", retired: true },
              { name: "GAMEBANANA_BINDINGS" },
              { name: "RENAMED_BINDINGS" },
            ],
          }
        : kind,
    );
    assert.deepEqual(
      authorityInventoryErrors(detectAuthorities(root, context, retiredMember)).filter((error) =>
        error.includes("provider-binding-table"),
      ),
      [],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.match(
    authorityInventoryErrors([
      report({
        kind: "table",
        identities: ["x"],
        members: [{ name: "EMPTY_BINDINGS", declared_retired: false, rows: 0 }],
      }),
    ])[0]!,
    /found EMPTY_BINDINGS but read no rows/u,
  );
});

void test("test-only cfg code is excluded; feature-gated code is its own kind", () => {
  assert.equal(cfgClass("test"), "test");
  assert.equal(cfgClass('any(test, feature = "qualification-fixtures")'), "feature");
  assert.equal(cfgClass('feature = "qualification-fixtures"'), "feature");
  assert.equal(cfgClass("any(test, windows)"), "production");
  assert.equal(cfgClass('not(any(test, feature = "qualification-fixtures"))'), "production");
  assert.equal(cfgClass('any(test, not(feature = "qualification-fixtures"))'), "production");
  assert.equal(cfgClass('all(windows, not(feature = "qualification-fixtures"))'), "production");
  assert.equal(
    cfgClass('all(not(test), any(windows, feature = "qualification-fixtures"))'),
    "feature",
  );
  const text = [
    "a();",
    '#[cfg(any(test, feature = "q"))]',
    'const Q: &str = "q-id";',
    "#[cfg(any(test, windows))]",
    'const W: &str = "w-id";',
    "#[cfg(test)]",
    'mod tests { fn f() -> Result<A, B> { "t-id" } }',
    "enum E {",
    "    #[cfg(test)]",
    "    Fixture,",
    "    Kept,",
    "}",
  ].join("\n");
  const { production, featureGated } = partitionCfgItems(text);
  assert.match(production, /"w-id"/u);
  assert.match(production, /Kept,\n\}/u);
  assert.doesNotMatch(production, /q-id|t-id|Fixture/u);
  assert.match(featureGated, /"q-id"/u);
  assert.doesNotMatch(featureGated, /t-id/u);
  assert.match(withoutTestItems(text), /q-id/u);

  // Feature-gated module files are inventoried as qualification fixture code.
  const inputs = routeFitInputs();
  const { context } = fixtureContext(inputs);
  const root = authorityTree(true, {
    [`${src}/release.rs`]:
      '#[cfg(any(test, feature = "qualification-fixtures"))]\nmod qualified;\n#[cfg(test)]\nmod pure;\n',
    [`${src}/release/qualified.rs`]: 'pub const PORT: &str = "data-port";\n',
    [`${src}/release/pure.rs`]: 'pub const PORT: &str = "pending-github";\n',
  });
  try {
    const reports = detectAuthorities(root, context, fixtureKinds(true));
    const fixtures = reports.find((entry) => entry.kind === "qualification-fixture-title-code")!;
    assert.deepEqual(fixtures.identities, ["coded-port", "data-port"]);
    assert.ok(fixtures.files.includes(`${src}/release/qualified.rs`));
    const literal = reports.find((entry) => entry.kind === "core-title-literal")!;
    assert.ok(!literal.identities!.includes("data-port"));
    assert.ok(!literal.identities!.includes("pending-github"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("a cfg predicate that requires test is test code; alternatives and negations are not", () => {
  for (const predicate of [
    "test",
    "all(test, windows)",
    'all(test, target_os = "linux", target_arch = "x86_64")',
    "all(test, any(unix, windows))",
    "all(unix, all(test, windows))",
    'all(test, feature = "qualification-fixtures")',
    "any(test, all(test, windows))",
  ])
    assert.equal(cfgClass(predicate), "test", predicate);
  for (const predicate of [
    "any(test, windows)",
    "not(test)",
    "all(not(test), windows)",
    "all(windows, any(test, unix))",
    "windows",
    'test = "x"',
    "all(test windows)",
    "all()",
    "any()",
  ])
    assert.equal(cfgClass(predicate), "production", predicate);
  const text = [
    "#[cfg(all(test, windows))]",
    'mod tests { fn f() { "w-id" } }',
    "#[cfg(not(test))]",
    'const N: &str = "n-id";',
    '#[cfg(all(test, target_os = "linux"))]',
    'const L: &str = "l-id";',
  ].join("\n");
  const { production, featureGated } = partitionCfgItems(text);
  assert.match(production, /"n-id"/u);
  assert.doesNotMatch(production, /w-id|l-id/u);
  assert.equal(featureGated, "");
  assert.doesNotMatch(withoutTestItems(text), /w-id|l-id/u);
});

void test("title-named Core enum variants and modules are inventoried from catalog keys", () => {
  const inputs = routeFitInputs();
  const { context } = fixtureContext(inputs);
  const root = authorityTree(false, {
    [`${src}/preparation.rs`]: [
      "pub enum PreparationMode {",
      "    /// A note (with an unbalanced parenthesis.",
      "    Default,",
      "    CodedPort200Legacy,",
      "    Shaped { inner: u32 },",
      "}",
    ].join("\n"),
    [`${src}/generic.rs`]: "pub enum Phase { DataPortable, Port }\n",
  });
  try {
    const kinds = fixtureKinds(false).map((kind) =>
      kind.kind === "title-named-core-item" ? { ...kind, retired: false } : kind,
    );
    const named = detectAuthorities(root, context, kinds).find(
      (entry) => entry.kind === "title-named-core-item",
    )!;
    assert.deepEqual(named.identities, ["coded-port"]);
    assert.deepEqual(named.files, [`${src}/preparation.rs`]);
    assert.equal(named.count, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("the script names no catalog identity outside its tests", () => {
  const view = JSON.parse(main(["--json"], repositoryRoot)) as ReturnType<typeof programView>;
  const ids = new Set(view.subjects.map((entry) => entry.id));
  const script = readFileSync(new URL("./maintenance-program-view.mts", import.meta.url), "utf8");
  const literals = [...script.matchAll(/["'`]([a-z0-9][a-z0-9-]*[a-z0-9])["'`]/gu)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(
    literals.filter((literal) => ids.has(literal)),
    [],
  );
  assert.deepEqual(view.gates.retired_authority.unknown_kinds, []);
  assert.notEqual(view.gates.retired_authority.state, "unknown");
});

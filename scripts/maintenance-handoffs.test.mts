import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  disabledCapabilities,
  handoffEntry,
  handoffGuidance,
  handoffOperationId,
  handoffRegistry,
  handoffSubject,
  hostedIntakeHandoffs,
  nextAction,
  openHandoffs,
  parseHandoffSubject,
  releaseContentHandoffs,
  releaseHealthHandoffs,
  renderHandoffs,
  upstreamHandoffs,
  withoutHandoff,
} from "./maintenance-handoffs.mts";
import { originalLocationReasons } from "./upstream-location-reasons.mts";
import { renderDigestMarkdown } from "./maintenance-inventory.mts";
import { isRecord } from "./runtime-values.mts";
import { disposableDirectory } from "./fixtures/disposable-directory.mts";
import { readFixtureModuleClosure } from "./fixtures/module-closure.mts";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

void test("every attention kind has one disabled registry entry with an exact reason and resume condition", () => {
  assert.deepEqual(
    handoffRegistry.map(({ kind }) => kind),
    [
      "release-health-relocation",
      "release-health-condition",
      "upstream-observer-exception",
      "hosted-intake-blocked",
      "hosted-intake-holds",
      "release-content-finding",
    ],
  );
  for (const entry of handoffRegistry) {
    assert.equal(entry.dispatch, "disabled", entry.kind);
    assert.ok(["owner-only", "protected", "routine"].includes(entry.authority), entry.kind);
    for (const text of [
      entry.action,
      entry.invocation,
      entry.receipt,
      entry.disabled_reason,
      entry.resume_condition,
    ])
      assert.ok(text.trim().length >= 20, `${entry.kind}: ${text}`);
    // Handoffs are not a backlog: no planning or ownership fields.
    for (const field of ["priority", "owner", "status", "assignee"])
      assert.ok(!(field in entry), `${entry.kind} has no ${field}`);
  }
  // Owner-only executors stay owner-only; definition publication has no handoff.
  assert.deepEqual(
    handoffRegistry.filter(({ authority }) => authority === "owner-only").map(({ kind }) => kind),
    ["release-health-relocation", "hosted-intake-blocked", "hosted-intake-holds"],
  );
  assert.ok(!handoffRegistry.some(({ kind }) => kind.includes("publication")));
  assert.deepEqual(
    withoutHandoff.map(([source]) => source),
    ["definition-publication", "core-port-capabilities"],
  );
  assert.ok(disabledCapabilities.some((capability) => capability.startsWith("executor dispatch")));
});

void test("every referenced workflow exists with the registry's name, trigger and inputs", () => {
  for (const entry of handoffRegistry) {
    if (!entry.workflow) continue;
    const workflow = parse(
      readFileSync(path.join(repositoryRoot, entry.workflow.file), "utf8"),
    ) as unknown;
    assert.ok(isRecord(workflow) && isRecord(workflow.on), entry.workflow.file);
    assert.equal(workflow.name, entry.workflow.name, entry.workflow.file);
    const trigger = workflow.on[entry.workflow.trigger];
    assert.ok(trigger !== undefined, `${entry.workflow.file} has ${entry.workflow.trigger}`);
    const basename = path.posix.basename(entry.workflow.file);
    if (entry.workflow.trigger === "workflow_dispatch") {
      const inputs = isRecord(trigger) && isRecord(trigger.inputs) ? trigger.inputs : {};
      assert.deepEqual(
        Object.keys(inputs).filter((name) => entry.workflow!.inputs.includes(name)),
        [...entry.workflow.inputs],
        `${basename} declares every registry input`,
      );
      assert.ok(entry.invocation.includes(`gh workflow run ${basename} --ref main`), entry.kind);
      // The invocation passes exactly the registry's inputs.
      assert.deepEqual(
        [...entry.invocation.matchAll(/ -f ([a-z_]+)=/gu)].map((match) => match[1]),
        [...entry.workflow.inputs],
        entry.kind,
      );
      // Every required input without a default is named.
      for (const [name, input] of Object.entries(inputs))
        if (isRecord(input) && input.required === true && input.default === undefined)
          assert.ok(entry.workflow.inputs.includes(name), `${entry.kind} passes required ${name}`);
    } else {
      // A scheduled report is the receipt; no dispatch invocation is offered.
      assert.equal(entry.workflow.trigger, "schedule", entry.kind);
      assert.ok(!entry.invocation.includes("gh workflow run"), entry.kind);
      assert.match(entry.receipt, /scheduled main/u, entry.kind);
    }
    assert.equal(entry.executor, basename, entry.kind);
  }
  // The owner-only relocation evidence job is gated on the owner as actor and triggering actor.
  const evidence = readFileSync(
    path.join(repositoryRoot, ".github/workflows/upstream-relocation-evidence.yml"),
    "utf8",
  );
  assert.match(evidence, /github\.actor == 'boburning'/u);
  assert.match(evidence, /github\.triggering_actor == 'boburning'/u);
});

void test("subject keys and operation identities are deterministic and within the store's checks", () => {
  const subject = handoffSubject("upstream-observer-exception", "port:alpha@linux-x86-64");
  assert.equal(subject, "handoff:upstream-observer-exception:port:alpha@linux-x86-64");
  assert.match(subject, /^[a-z][a-z0-9-]{0,31}:[!-~]+$/u);
  assert.deepEqual(parseHandoffSubject(subject), {
    kind: "upstream-observer-exception",
    source: "port:alpha@linux-x86-64",
  });
  assert.equal(parseHandoffSubject("port:alpha@linux-x86-64"), null);
  assert.equal(
    handoffOperationId("upstream-observer-exception", "port:alpha@linux-x86-64", 3),
    "handoff.upstream-observer-exception.port:alpha.linux-x86-64.3",
  );
  assert.equal(
    handoffOperationId("upstream-observer-exception", "port:alpha@linux-x86-64", 3, 41),
    "handoff.upstream-observer-exception.port:alpha.linux-x86-64.3.a41",
  );
  assert.match(
    handoffOperationId("release-health-condition", `port:${"a".repeat(190)}`, 12, 7),
    /^handoff\.release-health-condition\.sha256-[0-9a-f]{40}\.12\.a7$/u,
  );
  const long = handoffOperationId("release-health-condition", `port:${"a".repeat(190)}`, 12);
  assert.match(long, /^handoff\.release-health-condition\.sha256-[0-9a-f]{40}\.12$/u);
  assert.equal(long, handoffOperationId("release-health-condition", `port:${"a".repeat(190)}`, 12));
  for (const id of [long, handoffOperationId("hosted-intake-holds", "intake:40", 1)])
    assert.match(id, /^[A-Za-z0-9._:-]{1,200}$/u);
});

void test("release health sends only GitHub original-location rules to relocation evidence", () => {
  const condition = (key: string, rule: string, overrides = {}) => ({
    key,
    material_sha256: "m",
    classification: "unclassified-or-actionable",
    accounted_for: false,
    port_id: "alpha",
    operation: "observe-availability",
    rule,
    provider: "github",
    location: "owner/alpha",
    release_ref: null,
    http_status: 404,
    first_seen: "2026-11-01T00:00:00Z",
    resume_condition: "Retry after the provider recovers.",
    ...overrides,
  });
  const handoffs = releaseHealthHandoffs(
    new Map([
      [
        "port:alpha",
        {
          freshness: "fresh-complete",
          conditions: [
            // The monitor's own rules (check-catalog-repositories statusReason).
            condition("k1", "provider-redirect", { http_status: 301 }),
            condition("k2", "inaccessible-or-missing"),
            // A transient transport failure is a condition, never a relocation.
            condition("k3", "transport", { http_status: null }),
            // Non-GitHub original locations are not GitHub relocations.
            condition("k4", "inaccessible-or-missing", { provider: "gitlab" }),
            condition("k5", "transport", { provider: "direct-manifest", http_status: null }),
            // Routine accounted provider conditions stay quiet, as in the report.
            condition("k6", "rate-limit", {
              accounted_for: true,
              classification: "provider-reported-outage",
            }),
          ],
        },
      ],
      ["port:beta", { freshness: "fresh-complete", conditions: [] }],
    ]),
  );
  assert.deepEqual([...originalLocationReasons], ["provider-redirect", "inaccessible-or-missing"]);
  assert.deepEqual(
    handoffs.map(({ kind, source, condition: value }) => [
      kind,
      source,
      (value.conditions as { key: string }[]).map(({ key }) => key),
    ]),
    [
      ["release-health-relocation", "port:alpha", ["k1", "k2"]],
      ["release-health-condition", "port:alpha", ["k3", "k4", "k5"]],
    ],
  );
  // Observation clocks and HTTP status are not part of the condition.
  const [relocation] = handoffs;
  assert.ok(!("first_seen" in (relocation!.condition.conditions as object[])[0]!));
  assert.ok(!("http_status" in (relocation!.condition.conditions as object[])[0]!));
});

void test("upstream exceptions and hosted intake requests become handoffs by their own classification", () => {
  const source = (exception_rule: string | null, exception_key: string | null = "e") => ({
    source_key: `s-${exception_rule}`,
    provider: "github",
    repository: "owner/alpha",
    repository_id: 7,
    last_complete_facts_sha256: null,
    last_change_at: null,
    exception_key,
    exception_rule,
    catalog_definition_sha256: null,
  });
  assert.deepEqual(
    upstreamHandoffs(
      new Map([
        ["port:alpha", { sources: [source("repository-unavailable"), source(null, null)] }],
        // Partial-progress stops are routine continuation.
        ["port:beta", { sources: [source("budget")] }],
      ]),
    ),
    [
      {
        kind: "upstream-observer-exception",
        source: "port:alpha",
        condition: {
          exceptions: [
            {
              source_key: "s-repository-unavailable",
              repository: "owner/alpha",
              exception_key: "e",
              exception_rule: "repository-unavailable",
            },
          ],
        },
      },
    ],
  );
  const hold = { http_status: 404, resume: "Use owner process dispatch." };
  const request = (id: number, overrides = {}) => ({
    request_comment: id,
    receipt_comment: id + 1,
    withdrawn: false,
    reconciles: null,
    superseded_by: [],
    status: "complete",
    blocker: null,
    slots: [
      {
        candidate_index: 0,
        port_key: "game",
        repository_id: 7,
        upstream: "u",
        delivery_status: "delivered",
        linked_issue: 1,
        existing: false,
        hold: null,
      },
    ],
    ...overrides,
  });
  const handoffs = hostedIntakeHandoffs(
    new Map<string, unknown>([
      ["intake:10", request(10)],
      ["intake:20", request(20, { status: "blocked", blocker: { code: "operation_failed" } })],
      ["intake:30", request(30, { status: "blocked", withdrawn: true })],
      [
        "intake:40",
        request(40, {
          status: "complete_with_holds",
          slots: [{ ...request(0).slots[0]!, hold }],
        }),
      ],
      ["intake:50", request(50, { status: "partial" })],
    ]),
  );
  assert.deepEqual(handoffs, [
    {
      kind: "hosted-intake-blocked",
      source: "intake:20",
      condition: {
        request_comment: 20,
        receipt_comment: 21,
        reconciles: null,
        blocker: "operation_failed",
      },
    },
    {
      kind: "hosted-intake-holds",
      source: "intake:40",
      condition: {
        request_comment: 40,
        receipt_comment: 41,
        holds: [{ candidate_index: 0, port_key: "game", repository_id: 7, ...hold }],
      },
    },
  ]);
});

void test("release-content findings and uninspected packages become routine handoffs that never write a hold", () => {
  const finding = (platform: string) => ({
    platform,
    repository: "up/alpha",
    tag: "v1",
    asset: `alpha-${platform}.zip`,
    sha256: "a".repeat(64),
    rules: 2,
    signals: [{ path: "data/x.bin", kind: "cartridge-header", reason: "synthetic header" }],
    signal_count: 1,
  });
  const accounted = {
    reason: "Synthetic homebrew test cartridge, reviewed.",
    evidence: "https://github.com/boburning/portcove/issues/9",
  };
  const handoffs = releaseContentHandoffs(
    new Map<string, unknown>([
      [
        "port:alpha",
        {
          findings: [finding("linux-x86-64"), { ...finding("windows-x86-64"), accounted }],
          unscannable: [],
        },
      ],
      // A port whose only finding is accounted needs nothing.
      ["port:delta", { findings: [{ ...finding("linux-x86-64"), accounted }], unscannable: [] }],
      // Coverage notes are facts, not attention.
      [
        "port:beta",
        {
          findings: [],
          unscannable: [
            { platform: "linux-x86-64", code: "no-release" },
            { platform: "windows-x86-64", code: "no-single-asset" },
          ],
        },
      ],
      // A package the scan could not inspect needs the same review.
      [
        "port:gamma",
        {
          findings: [],
          unscannable: [
            { platform: "linux-x86-64", code: "digest-mismatch" },
            { platform: "macos-arm64", code: "no-release" },
            { platform: "windows-x86-64", code: "unlistable" },
          ],
        },
      ],
    ]),
  );
  assert.deepEqual(handoffs, [
    {
      kind: "release-content-finding",
      source: "port:alpha",
      condition: { findings: [finding("linux-x86-64")], unscannable: [] },
    },
    {
      kind: "release-content-finding",
      source: "port:gamma",
      condition: {
        findings: [],
        unscannable: [
          { platform: "linux-x86-64", code: "digest-mismatch" },
          { platform: "windows-x86-64", code: "unlistable" },
        ],
      },
    },
  ]);
  const entry = handoffEntry("release-content-finding")!;
  assert.equal(entry.source, "release-content");
  assert.equal(entry.authority, "routine");
  assert.equal(entry.workflow?.trigger, "schedule");
  assert.match(entry.action, /download_block_reason/u);
  assert.match(entry.action, /never writes a hold/u);
  assert.match(entry.action, /inspects manually any package the scan could not read/u);
  assert.match(
    entry.receipt,
    /no longer reports the finding or the not-scannable package; a held listing leaves the scan targets/u,
  );
  const text = nextAction({
    subject_key: handoffSubject("release-content-finding", "port:alpha"),
    kind: "release-content-finding",
    source_subject: "port:alpha",
    sequence: 1,
    assessment_id: 3,
    updated_at: "2026-11-13T00:00:00Z",
    condition: handoffs[0]!.condition,
    registry: entry,
    operation: null,
  });
  assert.match(
    text,
    /Authority: routine\. Dispatch disabled: Confirming game data needs a person/u,
  );
  assert.match(text, /no operation recorded \(fence 1\)/u);
});

void test("open handoffs project onto the registry with their disabled dispatch and operation fence", () => {
  const [open, unknown] = openHandoffs([
    {
      subject_key: "handoff:hosted-intake-holds:intake:40",
      sequence: 2,
      assessment_id: 9,
      updated_at: "2026-11-11T00:00:00Z",
      explanation: { condition: { request_comment: 40 } },
      operation: {
        operation_id: "handoff.hosted-intake-holds.intake:40.1",
        state: "planned",
        fence_sequence: 1,
        fence_assessment_id: 4,
        revision: 1,
        executor: "hosted-discovery-intake.yml",
      },
    },
    {
      subject_key: "handoff:retired-kind:port:x",
      sequence: 1,
      assessment_id: 5,
      updated_at: "2026-11-11T00:00:00Z",
      explanation: {},
      operation: null,
    },
  ]);
  assert.equal(open!.kind, "hosted-intake-holds");
  assert.equal(open!.source_subject, "intake:40");
  const text = nextAction(open!);
  assert.match(text, /gh workflow run hosted-discovery-intake\.yml --ref main -f mode=process/u);
  assert.match(text, /Authority: owner-only\. Dispatch disabled: Process dispatch/u);
  assert.match(text, /Resume: The owner delegates process dispatch/u);
  assert.match(
    text,
    /operation handoff\.hosted-intake-holds\.intake:40\.1 planned at fence 1 \(stale; current 2 on assessment 9\)/u,
  );
  assert.equal(unknown!.registry, null);
  assert.match(nextAction(unknown!), /Unregistered handoff kind retired-kind; dispatch disabled/u);
  assert.match(renderHandoffs([]), /No open handoffs/u);
  assert.match(renderHandoffs([open!]), /^handoff:hosted-intake-holds:intake:40 \(sequence 2\)/u);
});

void test("the maintenance inventory loads without the monitor or its reviewed accounting file", (context) => {
  // Every module the CLI can reach, lazily loaded sources included, stays clear of the monitor.
  const closure = readFixtureModuleClosure(repositoryRoot, ["scripts/maintenance-inventory.mts"]);
  const paths = closure.modules.map((module) => module.path);
  assert.ok(paths.includes("scripts/maintenance-handoffs.mts"));
  assert.ok(paths.includes("scripts/upstream-location-reasons.mts"));
  assert.ok(!paths.includes("scripts/check-catalog-repositories.mts"));
  assert.deepEqual(
    closure.modules
      .filter((module) => module.bytes.includes("upstream-health-accounting"))
      .map((module) => module.path),
    [],
  );
  // Load the eager closure from a copy that has no .github directory at all.
  const root = disposableDirectory(context, path.join(tmpdir(), "portcove-maintenance-load-"));
  const eager = readFixtureModuleClosure(repositoryRoot, ["scripts/maintenance-inventory.mts"], {
    includeDynamicImports: false,
  });
  assert.deepEqual(
    eager.external.filter((name) => !name.startsWith("node:")),
    [],
  );
  for (const module of eager.modules) {
    mkdirSync(path.dirname(path.join(root, module.path)), { recursive: true });
    writeFileSync(path.join(root, module.path), module.bytes);
  }
  writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      'const inventory = await import("./scripts/maintenance-inventory.mts"); const handoffs = await import("./scripts/maintenance-handoffs.mts"); console.log(typeof inventory.main, handoffs.handoffRegistry.length);',
    ],
    { cwd: root, encoding: "utf8", timeout: 30_000, windowsHide: true },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), `function ${handoffRegistry.length}`);
});

void test("accounted release-health conditions follow their recorded resume condition, not new accounting", () => {
  const condition = (key: string, overrides = {}) => ({
    key,
    material_sha256: "m",
    classification: "catalog-declared-unavailable-original",
    accounted_for: true,
    port_id: "alpha",
    operation: "observe-availability",
    rule: "inaccessible-or-missing",
    provider: "direct-manifest",
    location: "https://example.com/alpha.zip",
    release_ref: null,
    http_status: 404,
    first_seen: "2026-11-01T00:00:00Z",
    resume_condition:
      "Recheck original access/location; a 404 does not establish deletion or succession.",
    ...overrides,
  });
  const unaccounted = condition("k2", {
    accounted_for: false,
    classification: "unclassified-or-actionable",
    rule: "transport",
    location: "https://example.com/beta.zip",
    resume_condition: "Recheck provider transport; this attempt did not establish reachability.",
  });
  const handoffs = (conditions: unknown[]) =>
    releaseHealthHandoffs(new Map([["port:alpha", { freshness: "fresh-complete", conditions }]]));
  // The maintained triage keeps the accounted condition visible, so it stays a handoff.
  const [accounted] = handoffs([condition("k1")]);
  assert.equal(accounted?.kind, "release-health-condition");
  const entry = handoffEntry("release-health-condition")!;
  const guidance = handoffGuidance(entry, accounted.condition);
  assert.doesNotMatch(guidance.action, /account for an expected provider condition/u);
  assert.match(
    guidance.action,
    /accounted for by reviewed scope; no new relocation evidence or accounting is needed/u,
  );
  assert.doesNotMatch(guidance.invocation, /accounting or fix PR/u);
  assert.equal(
    guidance.resume_condition,
    "inaccessible-or-missing at https://example.com/alpha.zip: Recheck original access/location; a 404 does not establish deletion or succession.",
  );
  const [open] = openHandoffs([
    {
      subject_key: handoffSubject("release-health-condition", "port:alpha"),
      sequence: 1,
      updated_at: "2026-11-11T00:00:00Z",
      explanation: { condition: accounted.condition },
      operation: null,
    },
  ]);
  const text = nextAction(open!);
  assert.match(text, /Authority: routine\. Dispatch disabled: The remedy/u);
  assert.match(
    text,
    /Resume: inaccessible-or-missing at https:\/\/example\.com\/alpha\.zip: Recheck/u,
  );
  assert.match(text, /Receipt: The next scheduled main upstream-health report/u);
  // Mixed: the unaccounted condition keeps the registry prescription; the accounted one is named.
  const [mixed] = handoffs([condition("k1"), unaccounted]);
  const both = handoffGuidance(entry, mixed!.condition);
  assert.ok(both.action.startsWith(entry.action));
  assert.match(
    both.action,
    /Already accounted for by reviewed scope \(no new relocation evidence or accounting\): inaccessible-or-missing at https:\/\/example\.com\/alpha\.zip/u,
  );
  assert.equal(both.invocation, entry.invocation);
  assert.equal(both.resume_condition, entry.resume_condition);
  // Unaccounted conditions and every other kind keep their registry entry unchanged.
  const [plain] = handoffs([unaccounted]);
  assert.deepEqual(handoffGuidance(entry, plain!.condition), {
    action: entry.action,
    invocation: entry.invocation,
    resume_condition: entry.resume_condition,
    receipt: entry.receipt,
  });
  assert.deepEqual(
    handoffGuidance(handoffEntry("upstream-observer-exception")!, accounted.condition).action,
    handoffEntry("upstream-observer-exception")!.action,
  );
  // The changes-only digest names the same action from the recorded condition.
  const digestEntry = (handoff_condition: unknown) => ({
    notification_key: "transition:handoff:release-health-condition:port:alpha:1",
    subject_key: handoffSubject("release-health-condition", "port:alpha"),
    sequence: 1,
    previous_state: null,
    state: "needs-attention",
    returns_to_earlier_result: false,
    recorded_at: "2026-11-11T00:00:00Z",
    handoff_condition,
  });
  const digest = (handoff_condition: unknown) =>
    renderDigestMarkdown({
      format: "portcove-maintenance-digest",
      format_version: 1,
      entries: [digestEntry(handoff_condition)],
    });
  assert.match(
    digest(accounted.condition),
    /next action: The monitor records this condition as accounted for/u,
  );
  assert.match(
    digest(plain!.condition),
    /next action: Follow the monitor's recorded resume condition; account for/u,
  );
});

void test("accounted GitHub relocation conditions follow their reviewed resume condition, not new relocation evidence", () => {
  const reviewed = (key: string, rule: string, overrides = {}) => ({
    key,
    material_sha256: "m",
    classification:
      "reviewed-endpoint-condition; availability-unknown; lineage-separately-recorded",
    accounted_for: true,
    port_id: "alpha",
    operation: "observe-availability",
    rule,
    provider: "github",
    location: `owner/${key}`,
    release_ref: null,
    http_status: rule === "provider-redirect" ? 301 : 404,
    first_seen: "2026-11-01T00:00:00Z",
    resume_condition: `Reconsider exact original-location evidence for ${key}.`,
    ...overrides,
  });
  const handoffs = (conditions: unknown[]) =>
    releaseHealthHandoffs(new Map([["port:alpha", { freshness: "fresh-complete", conditions }]]));
  const entry = handoffEntry("release-health-relocation")!;
  // All accounted: still a relocation handoff (nothing hidden or reclassified), no new evidence prescribed.
  const all = handoffs([
    reviewed("k1", "provider-redirect"),
    reviewed("k2", "inaccessible-or-missing"),
  ]);
  assert.deepEqual(
    all.map(({ kind }) => kind),
    ["release-health-relocation"],
  );
  const guidance = handoffGuidance(entry, all[0]!.condition);
  assert.doesNotMatch(guidance.action, /Read bounded relocation evidence/u);
  assert.match(guidance.action, /no new relocation evidence or accounting is needed/u);
  assert.doesNotMatch(guidance.invocation, /upstream-relocation-evidence\.yml/u);
  assert.equal(
    guidance.resume_condition,
    "provider-redirect at owner/k1: Reconsider exact original-location evidence for k1.; inaccessible-or-missing at owner/k2: Reconsider exact original-location evidence for k2.",
  );
  const [open] = openHandoffs([
    {
      subject_key: handoffSubject("release-health-relocation", "port:alpha"),
      sequence: 1,
      updated_at: "2026-11-11T00:00:00Z",
      explanation: { condition: all[0]!.condition },
      operation: null,
    },
  ]);
  const text = nextAction(open!);
  assert.match(text, /Authority: owner-only\. Dispatch disabled: The evidence job runs only/u);
  assert.match(text, /Resume: provider-redirect at owner\/k1: Reconsider/u);
  // Mixed: the unaccounted redirect keeps the registry prescription; the reviewed one is named.
  const [mixed] = handoffs([
    reviewed("k1", "provider-redirect"),
    reviewed("k3", "provider-redirect", {
      accounted_for: false,
      classification: "unclassified-or-actionable",
      resume_condition: "Review the original location and redirect identity separately.",
    }),
  ]);
  const both = handoffGuidance(entry, mixed!.condition);
  assert.ok(both.action.startsWith(entry.action));
  assert.match(
    both.action,
    /Already accounted for by reviewed scope \(no new relocation evidence or accounting\): provider-redirect at owner\/k1: Reconsider exact original-location evidence for k1\.$/u,
  );
  assert.doesNotMatch(both.action, /owner\/k3/u);
  assert.equal(both.invocation, entry.invocation);
  assert.equal(both.resume_condition, entry.resume_condition);
  // None accounted: unchanged.
  const [plain] = handoffs([reviewed("k4", "provider-redirect", { accounted_for: false })]);
  assert.deepEqual(handoffGuidance(entry, plain!.condition), {
    action: entry.action,
    invocation: entry.invocation,
    resume_condition: entry.resume_condition,
    receipt: entry.receipt,
  });
});

void test("release-content guidance follows what the handoff holds", () => {
  const entry = handoffEntry("release-content-finding")!;
  const finding = { platform: "linux-x86-64", asset: "a.zip", sha256: "a".repeat(64), signals: [] };
  const guide = (condition: unknown) => handoffGuidance(entry, condition);
  const flagged = guide({ findings: [finding], unscannable: [] });
  assert.match(flagged.action, /^A person confirms the flagged files against the package\./u);
  assert.doesNotMatch(flagged.action, /relocation/u);
  assert.equal(
    flagged.receipt,
    "The next scheduled main release-content scan report no longer reports the finding; a held listing leaves the scan targets.",
  );
  const inspect = guide({
    findings: [],
    unscannable: [{ platform: "linux-x86-64", code: "digest-mismatch" }],
  });
  assert.match(
    inspect.action,
    /inspects by hand the package the scan could not read \(digest-mismatch\)/u,
  );
  assert.match(inspect.action, /release-content-accounting\.json/u);
  assert.match(inspect.receipt, /no longer reports the not-scannable package/u);
  // An unavailable release goes through the release-health relocation route.
  const moved = guide({
    findings: [],
    unscannable: [{ platform: "linux-x86-64", code: "release-unavailable" }],
  });
  assert.match(
    moved.action,
    /fix the listing's upstream location through the release-health relocation route/u,
  );
  assert.match(moved.action, /release-health-relocation handoff for this port, if open/u);
  assert.doesNotMatch(moved.action, /download_block_reason/u);
  assert.match(
    moved.invocation,
    /^the release-health-relocation route \(upstream-relocation-evidence\.yml\)/u,
  );
  assert.equal(
    moved.receipt,
    "The next scheduled main release-content scan report reads the release (the target is no longer release-unavailable); a held listing leaves the scan targets.",
  );
  const both = guide({
    findings: [finding],
    unscannable: [{ platform: "windows-x86-64", code: "release-unavailable" }],
  });
  assert.match(both.action, /confirms the flagged files.*relocation route/u);
  assert.match(both.receipt, /no longer reports the finding and reads the release/u);
  // An unreadable condition keeps the registry entry.
  assert.deepEqual(guide(null), {
    action: entry.action,
    invocation: entry.invocation,
    resume_condition: entry.resume_condition,
    receipt: entry.receipt,
  });
});

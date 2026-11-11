import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  disabledCapabilities,
  handoffOperationId,
  handoffRegistry,
  handoffSubject,
  hostedIntakeHandoffs,
  nextAction,
  openHandoffs,
  parseHandoffSubject,
  releaseHealthHandoffs,
  renderHandoffs,
  upstreamHandoffs,
  withoutHandoff,
} from "./maintenance-handoffs.mts";
import { candidateRules } from "./upstream-relocation-candidates.mts";
import { isRecord } from "./runtime-values.mts";

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
      "core-assessment-change",
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
    ["definition-publication"],
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
      assert.ok(entry.invocation.startsWith(`gh workflow run ${basename} `), entry.kind);
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
    } else assert.ok(entry.invocation.includes("#177"), entry.kind);
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
  const subject = handoffSubject("core-assessment-change", "port:alpha@linux-x86-64");
  assert.equal(subject, "handoff:core-assessment-change:port:alpha@linux-x86-64");
  assert.match(subject, /^[a-z][a-z0-9-]{0,31}:[!-~]+$/u);
  assert.deepEqual(parseHandoffSubject(subject), {
    kind: "core-assessment-change",
    source: "port:alpha@linux-x86-64",
  });
  assert.equal(parseHandoffSubject("port:alpha@linux-x86-64"), null);
  assert.equal(
    handoffOperationId("core-assessment-change", "port:alpha@linux-x86-64", 3),
    "handoff.core-assessment-change.port:alpha.linux-x86-64.3",
  );
  const long = handoffOperationId("release-health-condition", `port:${"a".repeat(190)}`, 12);
  assert.match(long, /^handoff\.release-health-condition\.sha256-[0-9a-f]{40}\.12$/u);
  assert.equal(long, handoffOperationId("release-health-condition", `port:${"a".repeat(190)}`, 12));
  for (const id of [long, handoffOperationId("hosted-intake-holds", "intake:40", 1)])
    assert.match(id, /^[A-Za-z0-9._:-]{1,200}$/u);
});

void test("release health splits relocation rules from other visible conditions", () => {
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
            condition("k2", "provider-redirect"),
            condition("k1", "repository-unavailable"),
            // Routine accounted provider conditions stay quiet, as in the report.
            condition("k3", "provider-rate-limit", {
              accounted_for: true,
              classification: "provider-reported-outage",
            }),
          ],
        },
      ],
      ["port:beta", { freshness: "fresh-complete", conditions: [] }],
    ]),
  );
  assert.ok(candidateRules.has("repository-unavailable"));
  assert.deepEqual(
    handoffs.map(({ kind, source, condition: value }) => [
      kind,
      source,
      (value.conditions as { key: string }[]).map(({ key }) => key),
    ]),
    [
      ["release-health-relocation", "port:alpha", ["k1"]],
      ["release-health-condition", "port:alpha", ["k2"]],
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

void test("open handoffs project onto the registry with their disabled dispatch and operation fence", () => {
  const [open, unknown] = openHandoffs([
    {
      subject_key: "handoff:hosted-intake-holds:intake:40",
      sequence: 2,
      updated_at: "2026-11-11T00:00:00Z",
      explanation: { condition: { request_comment: 40 } },
      operation: {
        operation_id: "handoff.hosted-intake-holds.intake:40.1",
        state: "planned",
        fence_sequence: 1,
        revision: 1,
        executor: "hosted-discovery-intake.yml",
      },
    },
    {
      subject_key: "handoff:retired-kind:port:x",
      sequence: 1,
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
    /operation handoff\.hosted-intake-holds\.intake:40\.1 planned at fence 1 \(stale; current 2\)/u,
  );
  assert.equal(unknown!.registry, null);
  assert.match(nextAction(unknown!), /Unregistered handoff kind retired-kind; dispatch disabled/u);
  assert.match(renderHandoffs([]), /No open handoffs/u);
  assert.match(renderHandoffs([open!]), /^handoff:hosted-intake-holds:intake:40 \(sequence 2\)/u);
});

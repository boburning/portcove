import {
  hostedAmendmentMarker,
  parseHostedAmendment,
  readHostedAmendment,
} from "./hosted-discovery-amendment.mts";
import { observationHash } from "./upstream-observer.mts";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  auditDispatchRequest,
  scheduledIntakeReceipts,
  scheduledReceiptOutcome,
  scheduledReceiptRequestKey,
  hostedTriggerRequest,
  readHostedOutcomes,
  runHostedIntakePasses,
  runHostedIntakeWorker,
} from "./hosted-discovery-intake-runner.mts";
import { scheduledAuditRequests } from "./hosted-discovery-intake-audits.mts";

const outcome = (
  request: number,
  continuation: "inventory_changed" | "budget_exhausted" | null = null,
  progress: string | null = null,
) => ({ request, status: continuation ? "incomplete" : "complete", continuation, progress });
const report = (...outcomes: ReturnType<typeof outcome>[]) => ({
  status: outcomes.every((o) => o.status === "complete") ? "passed" : "incomplete",
  requests: outcomes.length,
  outcomes,
});
void test("only the protected scheduled caller accepts exact nonduplicate audit continuations", () => {
  const ticket = { request: 33, binding: "a".repeat(64) };
  const env = {
    HOSTED_INTAKE_MODE: "resume-audits",
    GITHUB_EVENT_NAME: "schedule",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REPOSITORY: "boburning/portcove",
    GITHUB_WORKFLOW_REF:
      "boburning/portcove/.github/workflows/maintenance-inventory.yml@refs/heads/main",
    HOSTED_INTAKE_AUDIT_CONTINUATIONS: JSON.stringify([ticket]),
  };
  assert.deepEqual(scheduledAuditRequests(env), [ticket]);
  for (const key of ["GITHUB_EVENT_NAME", "GITHUB_REF", "GITHUB_REPOSITORY", "GITHUB_WORKFLOW_REF"])
    assert.throws(() => scheduledAuditRequests({ ...env, [key]: "unrelated" }));
  for (const rows of [
    [],
    [ticket, ticket],
    [{ ...ticket, binding: "bad" }],
    [{ ...ticket, request: "33" }],
  ])
    assert.throws(() =>
      scheduledAuditRequests({ ...env, HOSTED_INTAKE_AUDIT_CONTINUATIONS: JSON.stringify(rows) }),
    );
});

void test("scheduled receipt admission distinguishes reruns without changing the source or phase", () => {
  const run = { GITHUB_RUN_ID: "44907060987", GITHUB_RUN_ATTEMPT: "1", GITHUB_SHA: "a".repeat(40) };
  const first = scheduledReceiptRequestKey("before-audits", run);
  assert.equal(first, `github:44907060987:scheduled-intake:before-audits:${run.GITHUB_SHA}:1`);
  assert.equal(scheduledReceiptRequestKey("before-audits", run), first);
  assert.equal(
    scheduledReceiptRequestKey("before-audits", { ...run, GITHUB_RUN_ATTEMPT: "2" }),
    first.replace(/:1$/u, ":2"),
  );
  assert.notEqual(scheduledReceiptRequestKey("after-audits", run), first);
  assert.throws(
    () => scheduledReceiptRequestKey("before-audits", { ...run, GITHUB_RUN_ATTEMPT: undefined }),
    /exact GitHub run attempt/u,
  );
});

void test("a scheduled receipt-only result can finish without enqueueing an audit", async () => {
  assert.deepEqual(
    scheduledReceiptOutcome({
      tickets: [],
      revision: "hosted-intake:bound",
      receipts: { status: "passed" },
    }),
    {
      output:
        "audit_continuations=[]\nreceipt_revision=hosted-intake:bound\nreceipt_outcome=verified\n",
      outcome: "verified",
    },
  );
  assert.deepEqual(
    scheduledReceiptOutcome({
      tickets: [],
      revision: "bound\nforged=true",
      receipts: { status: "passed" },
    }),
    {
      output: "audit_continuations=[]\nreceipt_revision=\nreceipt_outcome=failed\n",
      outcome: "failed",
    },
  );
  await assert.rejects(
    scheduledIntakeReceipts("before-audits", { GITHUB_EVENT_NAME: "workflow_dispatch" }),
    /protected maintenance schedule/u,
  );
});

void test("a resource deferral carries neither a verified receipt fence nor audit tickets", () => {
  assert.deepEqual(
    scheduledReceiptOutcome({
      tickets: [],
      revision: undefined,
      receipts: { status: "unavailable", reason: "resource-deferred" },
    }),
    {
      output: "audit_continuations=[]\nreceipt_revision=\nreceipt_outcome=deferred\n",
      outcome: "deferred",
    },
  );
  assert.equal(
    scheduledReceiptOutcome({
      tickets: [],
      revision: undefined,
      receipts: { status: "unavailable", reason: "admission-failed" },
    }).outcome,
    "failed",
  );
});

void test("scheduled receipt reads refuse to substitute a Project token for the repository token", async () => {
  const result = await scheduledIntakeReceipts("after-audits", {
    HOSTED_INTAKE_MODE: "resume-audits",
    GITHUB_EVENT_NAME: "schedule",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REPOSITORY: "boburning/portcove",
    GITHUB_WORKFLOW_REF:
      "boburning/portcove/.github/workflows/maintenance-inventory.yml@refs/heads/main",
    GH_TOKEN: "project-token",
    PORTCOVE_DISCOVERY_DATABASE_URL: "invalid-unused-database-url",
  });
  assert.equal(result.receipts.status, "unavailable");
  assert.deepEqual(result.tickets, []);
});

void test("an unrelated incomplete receipt leaves bound tickets available and withholds the collection fence", () => {
  const ticket = { request: 33, binding: "a".repeat(64) };
  const outcome = scheduledReceiptOutcome({
    tickets: [ticket],
    revision: "hosted-intake:bound",
    receipts: { status: "failed", pending: 1, reason: "proof-pending" },
  });
  assert.equal(outcome.outcome, "failed");
  assert.equal(
    outcome.output,
    `audit_continuations=${JSON.stringify([ticket])}\nreceipt_revision=\nreceipt_outcome=failed\n`,
  );
});

void test("a progressing logical batch finishes beyond three inventory windows without operator reruns", () => {
  let passes = 0;
  const result = runHostedIntakePasses(() => {
    passes++;
    return report(outcome(17, passes < 6 ? "inventory_changed" : null, String(passes).repeat(64)));
  });
  assert.equal(result.status, "passed");
  assert.equal(passes, 6);
});
void test("the wall deadline and pass ceiling stop even continuously progressing workers", () => {
  let now = 0,
    calls = 0;
  const timed = runHostedIntakePasses(
    (_pass, _requests, remaining) => {
      assert(remaining <= 90 * 60000);
      calls++;
      now += 31 * 60000;
      return report(outcome(1, "inventory_changed", String(calls).padStart(64, "0")));
    },
    () => now,
  );
  assert.equal(timed.status, "incomplete");
  assert.equal(timed.stop_reason, "deadline");
  assert.equal(calls, 3);
  calls = 0;
  const capped = runHostedIntakePasses(() =>
    report(outcome(1, "inventory_changed", String(++calls).padStart(64, "0"))),
  );
  assert.equal(capped.stop_reason, "pass_limit");
  assert.equal(calls, 12);
});
void test("fresh passes drain transient holds and give the exhausted tail priority", () => {
  const calls: unknown[] = [];
  const result = runHostedIntakePasses((pass, requests) => {
    calls.push(requests);
    return pass === 1
      ? report(outcome(1), outcome(2, "inventory_changed"), outcome(3, "budget_exhausted"))
      : report(outcome(3), outcome(2));
  });
  assert.deepEqual(calls, [null, [3, 2]]);
  assert.equal(result.status, "passed");
});
void test("hard-held requests remain incomplete while independent requests finish", () => {
  let passes = 0;
  const result = runHostedIntakePasses(() =>
    ++passes === 1
      ? report({ ...outcome(1), status: "incomplete" }, outcome(2, "inventory_changed"))
      : report(outcome(2)),
  );
  assert.equal(passes, 2);
  assert.equal(result.status, "incomplete");
  assert.equal(result.outcomes[0]!.status, "incomplete");
});
void test("three snapshot passes are finite and repeated budget exhaustion without progress stops", () => {
  let passes = 0;
  assert.equal(
    runHostedIntakePasses(() => {
      passes++;
      return report(outcome(1, "inventory_changed"));
    }).status,
    "incomplete",
  );
  assert.equal(passes, 3);
  passes = 0;
  runHostedIntakePasses(() => {
    passes++;
    return report(outcome(1, "budget_exhausted", "a".repeat(64)));
  });
  assert.equal(passes, 2);
});
void test("missing, forged, inconsistent or crashed worker evidence never retries", () => {
  for (const value of [
    null,
    {},
    report(outcome(1), outcome(1)),
    { ...report(outcome(1)), status: "incomplete" },
    { ...report(outcome(1)), outcomes: [{ ...outcome(1), continuation: "http_error" }] },
  ])
    assert.throws(() => readHostedOutcomes(value));
  let calls = 0;
  assert.throws(() =>
    runHostedIntakePasses(() => {
      calls++;
      throw new Error("worker killed after POST");
    }),
  );
  assert.equal(calls, 1);
  assert.throws(() =>
    runHostedIntakePasses((pass) =>
      pass === 1 ? report(outcome(1, "inventory_changed")) : report(outcome(2)),
    ),
  );
});
void test("read-only queue movement gets bounded fresh reads without losing hard holds", () => {
  const changed = {
    status: "incomplete",
    requests: 0,
    outcomes: [],
    queue_continuation: "inventory_changed",
  };
  let passes = 0;
  const result = runHostedIntakePasses((pass, requests) => {
    passes++;
    if (pass === 1)
      return report({ ...outcome(1), status: "incomplete" }, outcome(2, "inventory_changed"));
    assert.deepEqual(requests, [2]);
    return pass === 2 ? changed : report(outcome(2));
  });
  assert.equal(passes, 3);
  assert.equal(result.status, "incomplete");
  assert.equal(runHostedIntakePasses(() => changed).status, "incomplete");
});
void test("a read-only queue budget hold resumes while unsupported queue failures stop", () => {
  let calls = 0;
  const result = runHostedIntakePasses(() =>
    ++calls === 1
      ? { status: "incomplete", requests: 0, outcomes: [], queue_continuation: "budget_exhausted" }
      : report(outcome(17)),
  );
  assert.equal(result.status, "passed");
  assert.equal(calls, 2);
  assert.throws(
    () =>
      runHostedIntakePasses(() => ({
        status: "incomplete",
        requests: 0,
        outcomes: [],
        queue_continuation: "http_error",
      })),
    /Malformed queue/u,
  );
});
void test("real worker exit/report/probe paths fail closed after a crash or signal", () => {
  const root = mkdtempSync(path.join(tmpdir(), "hosted-worker-"));
  mkdirSync(path.join(root, "scripts"));
  const worker = path.join(root, "scripts/hosted-discovery-intake.mts");
  const directory = path.join(root, "work");
  const run = (source: string) => {
    rmSync(directory, { recursive: true, force: true });
    writeFileSync(
      worker,
      `import {mkdirSync,writeFileSync} from 'node:fs';
      const dir='work/pass-'+process.env.HOSTED_INTAKE_PASS;mkdirSync(dir,{recursive:true});
      ${source}`,
    );
    return () => runHostedIntakeWorker(root, directory, 1, [17]);
  };
  try {
    const valid = JSON.stringify(report(outcome(17)));
    assert.deepEqual(
      readHostedOutcomes(run(`writeFileSync(dir+'/summary.json',${JSON.stringify(valid)});`)()),
      [outcome(17)],
    );
    assert.throws(
      run(`writeFileSync(dir+'/summary.json',${JSON.stringify(valid)});process.exit(2);`),
      /qualified outcome/u,
    );
    assert.throws(
      run(`writeFileSync(dir+'/confirmed-post','17');process.exit(1);`),
      /without a continuation report/u,
    );
    assert.throws(run(`process.kill(process.pid,'SIGTERM');`), /qualified outcome/u);
    assert.throws(
      run(`writeFileSync(dir+'/summary.json',${JSON.stringify(valid)});process.exit(1);`),
      /disagree/u,
    );
    assert.deepEqual(run(`writeFileSync(dir+'/write-probe.json','{}');`)(), {
      status: "passed",
      requests: 0,
      outcomes: [],
    });
    assert.throws(() => runHostedIntakeWorker(root, directory, 1, null), /already exists/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("audit dispatch binds every worker pass to one exact proposal", () => {
  assert.equal(auditDispatchRequest("process", ""), undefined);
  for (const bad of ["", "0", "01", "1 2", "9007199254740992"])
    assert.throws(() => auditDispatchRequest("audit", bad));
  assert.throws(() => auditDispatchRequest("process", "17"));
  const id = auditDispatchRequest("audit", "17");
  const result = runHostedIntakePasses(
    (pass, requests) => {
      assert.deepEqual(requests, [17]);
      return report(outcome(17, pass === 1 ? "inventory_changed" : null));
    },
    Date.now,
    id,
  );
  assert.equal(result.status, "passed");
  assert.throws(() => runHostedIntakePasses(() => report(outcome(18)), Date.now, id));
});

void test("complete with holds succeeds without an automatic continuation", () => {
  const result = runHostedIntakePasses((pass) => {
    assert.equal(pass, 1);
    return {
      status: "passed",
      requests: 1,
      outcomes: [
        {
          request: 42,
          status: "complete_with_holds",
          continuation: null,
          progress: null,
          counts: { delivered: 1, existing: 0, held: 1, pending: 1 },
        },
      ],
    };
  });
  assert.equal(result.status, "passed");
  assert.equal(result.outcomes[0]?.counts?.held, 1);
});

void test("owner amendments preserve the original proposal outcome and reject identity-changing fields", () => {
  const request = { id: 100, body: "Original exact proposal" };
  const value = {
    schema_version: 1,
    request_comment: 100,
    request_sha256: observationHash(request.body),
    receipt_comment: 200,
    receipt_sha256: "a".repeat(64),
    candidate_index: 0,
    port_key: "example-game",
    previous_body_sha256: "b".repeat(64),
    previous_evidence_sha256: null,
    replacement: {
      upstream: "https://github.com/example/game",
      evidence: "Dated evidence",
      resume: "Verify gameplay",
    },
    reason: "New primary release",
  };
  const encode = (input: unknown) =>
    `${hostedAmendmentMarker}\n\`\`\`json\n${JSON.stringify(input)}\n\`\`\``;
  const comment = {
    id: 300,
    body: encode(value),
    user: { login: "boburning" },
    issue_url: "https://api.github.com/repos/boburning/portcove/issues/177",
  };
  assert.deepEqual(readHostedAmendment(comment, "boburning", "boburning/portcove", request), value);
  assert.equal(hostedTriggerRequest({ comment }), 100);
  assert.equal(hostedTriggerRequest({ comment: { id: 400, body: "Original proposal" } }), 400);
  for (const replacement of [
    { ...value.replacement, repository_id: 42 },
    { ...value.replacement, port_key: "different" },
    { ...value.replacement, intent: { kind: "create" } },
  ])
    assert.throws(() => parseHostedAmendment(encode({ ...value, replacement })), /Invalid/u);
  // The exact Claude Code attribution footer is accepted; other trailing text is not.
  const footer = "\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_\n";
  assert.deepEqual(parseHostedAmendment(encode(value) + footer), value);
  for (const tail of ["\n\nrun this too", footer + "more"])
    assert.throws(() => parseHostedAmendment(encode(value) + tail), /Invalid/u);
  assert.throws(
    () =>
      readHostedAmendment(
        { ...comment, user: { login: "other" } },
        "boburning",
        "boburning/portcove",
        request,
      ),
    /Untrusted/u,
  );
  assert.throws(
    () =>
      readHostedAmendment(comment, "boburning", "boburning/portcove", {
        ...request,
        body: "Edited",
      }),
    /source differs/u,
  );
});

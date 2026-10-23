import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { encodeBackupEvidence, recoverBackupEvidence } from "./native-backup-evidence.mts";
import { AUDIT_STAGES, receiptEnvelope } from "./audit.mts";
import { renderDeepAuditSummary } from "./deep-audit-summary.mts";

function requiredFixture<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined, "expected fixture or source section is missing");
  return value;
}

const auditSummarySource = "a".repeat(40);
const identity = {
  source: auditSummarySource,
  workflowSha: auditSummarySource,
  workflowDigest: "b".repeat(64),
  workflowRef: "boburning/portcove/.github/workflows/deep-quality.yml@refs/heads/main",
  run: "12",
  attempt: "2",
  outcome: "success",
  exitCode: "0",
  started: "1700000000",
};
interface AuditSummaryFixture {
  format: number;
  kind: string;
  profile: string;
  head: string;
  success: boolean;
  completedAt: string;
  originalExitCode?: number;
  policyDecision?: {
    disposition: string;
    candidate: string;
    purpose: string;
    policyPassed: boolean;
    knownFinding: string;
    releaseAuthorization: string;
    scanPassed: boolean;
    scanExitCode: number;
  };
  stages: {
    id: string;
    recipe: string;
    originatingHead: string;
    status: string;
    durationMs: number;
    rationale: string;
    exitCode?: number;
  }[];
}
function fixture(): AuditSummaryFixture {
  return {
    format: 1,
    kind: "audit-run",
    profile: "complete",
    head: auditSummarySource,
    success: true,
    completedAt: "2023-11-14T22:13:21Z",
    stages: AUDIT_STAGES.filter((stage) => !stage.platforms).map((stage) => ({
      id: stage.id,
      recipe: stage.recipe,
      originatingHead: auditSummarySource,
      status: "passed",
      durationMs: 123,
      rationale: "secret diagnostic /private/path",
    })),
  };
}
void test("complete fresh success publishes bounded identities and stage results only", () => {
  const text = renderDeepAuditSummary(receiptEnvelope(fixture()), identity, binding(fixture()));
  assert.match(text, /Complete fresh audit receipt: passed/);
  assert.match(text, /Run: 12; attempt: 2/);
  assert.match(text, /\| rust \| passed \| 123 \| 0 \|/);
  assert.doesNotMatch(text, /secret diagnostic|private\/path|rationale/);
  assert.ok(text.length < 4096);
});
void test("failed full audit retains actual stage failure and exit status", () => {
  const payload = fixture();
  payload.success = false;
  Object.assign(requiredFixture(payload.stages.find((stage) => stage.id === "rust")), {
    status: "failed",
    exitCode: 2,
  });
  const text = renderDeepAuditSummary(
    receiptEnvelope(payload),
    {
      ...identity,
      outcome: "failure",
      exitCode: "1",
    },
    { ...binding(payload), exitCode: "1" },
  );
  assert.match(text, /receipt: failed/);
  assert.match(text, /\| rust \| failed \| 123 \| 2 \|/);
  assert.match(text, /Recorded audit exit status: 1/);
});

void test("development policy remains a failed audit and cannot cover another stage failure", () => {
  const payload = fixture();
  payload.success = false;
  payload.originalExitCode = 1;
  Object.assign(requiredFixture(payload.stages.find((stage) => stage.id === "dependency-policy")), {
    status: "failed",
    exitCode: 1,
  });
  payload.policyDecision = {
    disposition: "development-baseline",
    candidate: auditSummarySource,
    purpose: "development",
    policyPassed: true,
    knownFinding: "RUSTSEC-2024-0429",
    releaseAuthorization: "not-evaluated",
    scanPassed: false,
    scanExitCode: 1,
  };
  const text = renderDeepAuditSummary(receiptEnvelope(payload), identity, binding(payload));
  assert.match(text, /receipt: failed/);
  assert.match(text, /Original audit exit status: 1/);
  assert.match(text, /Recorded policy operation exit status: 0/);
  assert.match(text, /Development security policy operation outcome: success/);
  assert.doesNotMatch(text, /Recorded audit exit status: 0/);
  assert.match(text, /development security policy PASS/);
  assert.doesNotMatch(text, /receipt: passed/);
  Object.assign(requiredFixture(payload.stages.find((stage) => stage.id === "ui")), {
    status: "failed",
    exitCode: 1,
  });
  assert.match(
    renderDeepAuditSummary(receiptEnvelope(payload), identity, binding(payload)),
    /unavailable or invalid/,
  );
});
for (const [name, mutate] of [
  [
    "wrong source",
    (p: AuditSummaryFixture) => {
      p.head = "c".repeat(40);
    },
  ],
  [
    "stale receipt",
    (p: AuditSummaryFixture) => {
      p.completedAt = "2023-11-14T22:13:19Z";
    },
  ],
  [
    "partial profile",
    (p: AuditSummaryFixture) => {
      p.profile = "transition";
    },
  ],
  [
    "missing stage",
    (p: AuditSummaryFixture) => {
      p.stages.pop();
    },
  ],
  [
    "duplicate stage",
    (p: AuditSummaryFixture) => {
      p.stages[1] = requiredFixture(p.stages[0]);
    },
  ],
  [
    "reused stage",
    (p: AuditSummaryFixture) => {
      requiredFixture(p.stages[1]).status = "reused";
    },
  ],
  [
    "foreign stage source",
    (p: AuditSummaryFixture) => {
      requiredFixture(p.stages[1]).originatingHead = "c".repeat(40);
    },
  ],
  [
    "injected label",
    (p: AuditSummaryFixture) => {
      requiredFixture(p.stages[1]).id = "rust\nsecret";
    },
  ],
  [
    "invalid duration",
    (p: AuditSummaryFixture) => {
      requiredFixture(p.stages[1]).durationMs = -1;
    },
  ],
  [
    "false success",
    (p: AuditSummaryFixture) => {
      p.success = false;
    },
  ],
] as const)
  void test(`${name} never establishes coverage or success`, () => {
    const payload = fixture();
    mutate(payload);
    const text = renderDeepAuditSummary(receiptEnvelope(payload), identity, binding(payload));
    assert.match(text, /unavailable or invalid/);
    assert.doesNotMatch(text, /receipt: passed|\| rust/);
  });
void test("missing, corrupt, cancelled and unavailable exit receipts never pass", () => {
  for (const receipt of [undefined, {}, { ...receiptEnvelope(fixture()), integrity: "bad" }]) {
    assert.match(renderDeepAuditSummary(receipt, identity), /unavailable or invalid/);
  }
  for (const patch of [{ outcome: "cancelled" }, { exitCode: "" }, { exitCode: "1" }]) {
    assert.match(
      renderDeepAuditSummary(receiptEnvelope(fixture()), { ...identity, ...patch }),
      /unavailable or invalid/,
    );
  }
});
void test("invalid identity cannot inject public output", () => {
  for (const key of [
    "source",
    "workflowSha",
    "workflowDigest",
    "workflowRef",
    "run",
    "attempt",
    "outcome",
  ]) {
    const text = renderDeepAuditSummary(receiptEnvelope(fixture()), {
      ...identity,
      [key]: "secret\n<script>",
    });
    assert.match(text, /Identity unavailable or invalid/);
    assert.doesNotMatch(text, /secret|script>/);
  }
});

function binding(payload: AuditSummaryFixture) {
  return {
    ...identity,
    startedMs: 1700000000000,
    completedMs: 1700000002000,
    receiptIntegrity: receiptEnvelope(payload).integrity,
  };
}

void test("deep audit rejects another attempt, missing completion and future receipt", () => {
  const payload = fixture();
  for (const patch of [
    { attempt: "1" },
    { run: "11" },
    { workflowSha: "c".repeat(40) },
    { workflowDigest: "c".repeat(64) },
    { completedMs: undefined },
    { receiptIntegrity: "bad" },
  ]) {
    assert.match(
      renderDeepAuditSummary(receiptEnvelope(payload), identity, { ...binding(payload), ...patch }),
      /unavailable or invalid/,
    );
  }
  payload.completedAt = "2023-11-14T22:13:23Z";
  assert.match(
    renderDeepAuditSummary(receiptEnvelope(payload), identity, binding(payload)),
    /unavailable or invalid/,
  );
});

void test("real evidence bytes round-trip through timestamped job logs without exporting library or profile", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "backup-evidence-"));
  try {
    const source = path.join(root, "source");
    const native = path.join(source, "desktop-verify", "one-run", "native");
    await mkdir(path.join(native, "library"), { recursive: true });
    await mkdir(path.join(native, "webview"));
    await writeFile(path.join(source, "host.json"), '{"revision":"owned"}');
    const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 23]);
    await writeFile(path.join(native, "success.png"), image);
    await writeFile(path.join(native, "evidence.json"), '{"outcome":"failed"}');
    await writeFile(path.join(native, "library", "private.json"), "never-export");
    await writeFile(path.join(native, "webview", "profile.json"), "never-export");
    await writeFile(path.join(native, "session-startup-0.jsonl"), '{"owned_process":"identity"}\n');
    const encoded = await encodeBackupEvidence(source);
    const log = encoded
      .split("\n")
      .map((line) => `2026-10-01T00:00:00Z ${line}`)
      .join("\n");
    const recovered = path.join(root, "recovered");
    const names = await recoverBackupEvidence(log, recovered);
    assert.equal(names.length, 4);
    assert.ok(!names.some((name) => /library|webview/.test(name)));
    assert.deepEqual(
      await readFile(path.join(recovered, "desktop-verify/one-run/native/success.png")),
      image,
    );
    assert.equal(
      await readFile(path.join(recovered, "desktop-verify/one-run/native/evidence.json"), "utf8"),
      '{"outcome":"failed"}',
    );
    await assert.rejects(recoverBackupEvidence(log, recovered), /EEXIST/);
    await assert.rejects(
      recoverBackupEvidence(encoded + "\n" + encoded, path.join(root, "duplicate")),
      /Incomplete/,
    );
    await assert.rejects(
      recoverBackupEvidence(
        encoded.replace(/ [a-f0-9]{64} /, ` ${"0".repeat(64)} `),
        path.join(root, "corrupt"),
      ),
      /hash mismatch/,
    );
    await assert.rejects(
      recoverBackupEvidence("no retained evidence", path.join(root, "missing")),
      /Missing/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("export refuses links and oversized evidence instead of silently dropping required images", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "backup-evidence-"));
  try {
    const file = path.join(root, "large.json");
    await writeFile(file, Buffer.alloc(12 * 1024 * 1024 + 1));
    await assert.rejects(encodeBackupEvidence(root), /excessive/);
    await rm(file);
    await mkdir(path.join(root, "target"));
    await symlink(
      path.join(root, "target"),
      path.join(root, "linked.json"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(encodeBackupEvidence(root), /regular files/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

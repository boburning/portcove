import { main } from "./local-validation.mts";
import assert from "node:assert/strict";
import test from "node:test";
import { compareNextest, annotateNextest } from "./nextest-equivalence.mts";
import { buildValidationPlan, validateValidationPlan } from "./validation-plan.mts";
import { baselineSelection } from "./ci-baseline.mts";

void test("effective nextest comparison handles TOML syntax and keeps semantic changes broad", () => {
  const base = '[profile.default]\nretries=0\ntest-threads=2\nname="quoted # value"\n';
  const formatted =
    '# explanation\n[profile.default]\nname = "quoted # value"\ntest-threads = 2 # slots\nretries = 0\n';
  const proof = compareNextest(base, formatted);
  assert.ok(proof, "test host must provide Python tomllib for the semantic positive control");
  for (const changed of [
    base.replace("retries=0", "retries=1"),
    base.replace("test-threads=2", "test-threads=3"),
    base.replace("quoted # value", "quoted # other"),
    "[invalid",
    base.replace("retries=0", "retries=false"),
  ])
    assert.equal(compareNextest(base, changed), null);
  assert.equal(
    compareNextest('x="""hello\n# real content\n"""', 'x="""hello\n# changed content\n"""'),
    null,
  );
  assert.equal(compareNextest("[[a]]\nx=1\n[[a]]\nx=2", "[[a]]\nx=2\n[[a]]\nx=1"), null);
  assert.equal(
    compareNextest(base, formatted, (command, _args, options) => {
      assert.equal(command, process.platform === "win32" ? "python" : "python3");
      assert.equal(options.timeout, 5000);
      assert.equal(options.maxBuffer, 65536);
      return { status: 1, stdout: "" };
    }),
    null,
  );
  assert.equal(compareNextest(null, formatted), null);
  const changes = annotateNextest(
    [
      {
        status: "M",
        oldMode: "100644",
        newMode: "100644",
        oldPath: ".config/nextest.toml",
        newPath: ".config/nextest.toml",
      },
    ],
    () => base,
    () => formatted,
  );
  const plan = buildValidationPlan({
    changes,
    eventName: "pull_request",
    base: "a".repeat(40),
    mergeBase: "a".repeat(40),
    head: "b".repeat(40),
    checkout: "b".repeat(40),
  });
  validateValidationPlan(plan);
  assert.equal(plan.groups.includes("rust"), false);
  assert.equal(baselineSelection(plan).workspaceRust, false);
  const broad = buildValidationPlan({
    ...{
      changes: annotateNextest(
        changes.map(({ nextest_equivalence: _proof, ...c }) => c),
        () => base,
        () => base.replace("retries=0", "retries=1"),
      ),
      eventName: "pull_request",
      checkout: "b".repeat(40),
    },
  });
  assert.ok(broad.groups.includes("rust"));
});

void test("local command preserves effective-config proof through its hosted-plan conversion", async () => {
  const proof = compareNextest(
    "[profile.default]\nretries=0",
    "# comment\n[profile.default]\nretries=0",
  );
  assert.ok(proof);
  const messages: string[] = [];
  const original = console.log;
  try {
    console.log = (message) => messages.push(String(message));
    await main(["check", "--plan"], {
      readContext: () => ({
        base: "origin/main",
        baseSha: "a".repeat(40),
        mergeBase: "a".repeat(40),
        headSha: "b".repeat(40),
        changes: [
          {
            status: "M",
            path: ".config/nextest.toml",
            oldMode: "100644",
            newMode: "100644",
            nextest_equivalence: proof,
          },
        ],
      }),
    });
  } finally {
    console.log = original;
  }
  assert.ok(messages.some((line) => line === "Validation groups: catalog, rust-quality"));
  assert.equal(
    messages.some((line: string) => line.startsWith("- rust-workspace-tests:")),
    false,
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import { auditReleaseAge, introducedPackages } from "./dependency-release-age.mjs";
import { stringify } from "yaml";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const record = { resolution: { integrity: "sha512-YQ==" } };
const lock = (packages) => stringify({ lockfileVersion: "9.0", importers: {}, packages });
const times = { "1.55.0": "2026-10-10T06:12:45.950Z", "1.56.0": "2026-10-13T06:15:46.124Z" };
const observedAt = "2026-10-14T15:07:26.355Z";
const audit = (packages, options = {}) =>
  auditReleaseAge({
    baseLock: lock({ "lucide-react@1.49.0": record, "cn@0.4.0": record }),
    candidateLock: lock({ "cn@0.4.0": record, ...packages }),
    observedAt,
    timestamps: async () => times,
    ...options,
  });

test("historical Lucide selected 1.55 passes but actual locked 1.56 waits until October 16", async () => {
  assert.equal((await audit({ "lucide-react@1.55.0": record })).state, "eligible");
  const report = await audit({ "lucide-react@1.56.0": record });
  assert.equal(report.state, "waiting");
  assert.equal(report.route, "wait-for-release-age");
  assert.equal(report.findings[0].eligibleAt, "2026-10-16T06:15:46.124Z");
  assert.equal(
    (await audit({ "lucide-react@1.56.0": record }, { observedAt: "2026-10-16T06:15:46.123Z" }))
      .state,
    "waiting",
  );
  assert.equal(
    (await audit({ "lucide-react@1.56.0": record }, { observedAt: "2026-10-16T06:15:46.124Z" }))
      .state,
    "eligible",
  );
});
test("changed transitives, scopes and alias targets are audited; peer contexts deduplicate", async () => {
  const baseLock = lock({ "@scope/real@1.55.0(peer@1.0.0)": record });
  const candidateLock = lock({
    "@scope/real@1.55.0(peer@2.0.0)": record,
    "transitive@1.56.0": record,
    "transitive@1.56.0(peer@1.0.0)": record,
  });
  assert.deepEqual(
    introducedPackages(baseLock, candidateLock).map((p) => p.name),
    ["transitive"],
  );
  const report = await auditReleaseAge({
    baseLock,
    candidateLock,
    observedAt,
    timestamps: async () => times,
  });
  assert.equal(report.state, "waiting");
  assert.equal(report.findings.length, 1);
  assert.equal(
    (
      await auditReleaseAge({
        baseLock,
        candidateLock: lock({}),
        observedAt,
        timestamps: () => assert.fail("removals require no lookup"),
      })
    ).state,
    "eligible",
  );
});
test("pnpm 12 multi-document locks include manager and application package records", () => {
  const base =
    lock({ "manager@1.55.0": record }) + "---\n" + lock({ "lucide-react@1.55.0": record });
  const candidate =
    lock({ "manager@1.56.0": record }) + "---\n" + lock({ "lucide-react@1.56.0": record });
  assert.deepEqual(
    introducedPackages(base, candidate).map((item) => `${item.name}@${item.version}`),
    ["lucide-react@1.56.0", "manager@1.56.0"],
  );
  assert.throws(() => introducedPackages(base, candidate + "---\ninvalid: schema"), /schema/);
});
test("new local importer resolutions remain unknown rather than disappearing from the audit", async () => {
  const candidateLock = stringify({
    lockfileVersion: "9.0",
    packages: {},
    importers: {
      ".": { dependencies: { local: { specifier: "file:../local", version: "link:../local" } } },
    },
  });
  const report = await auditReleaseAge({ baseLock: lock({}), candidateLock, observedAt });
  assert.equal(report.state, "unknown");
  assert.equal(report.findings.length, 1);
});
test("missing timestamps, unavailable registry, malformed YAML and exotic resolutions fail closed", async () => {
  for (const options of [
    { timestamps: async () => ({}) },
    {
      timestamps: async () => {
        throw new Error("offline");
      },
    },
    { candidateLock: "packages: [\n" },
    {
      candidateLock: lock({ "git+https://example.invalid/repo": { resolution: { repo: "repo" } } }),
    },
    {
      candidateLock: lock({
        "pkg@1.55.0": {
          resolution: { tarball: "https://example.invalid/x", integrity: "sha512-YQ==" },
        },
      }),
    },
  ]) {
    const report = await audit({ "lucide-react@1.55.0": record }, options);
    assert.equal(report.state, "unknown");
    assert.equal(report.route, "controlled-review-required");
  }
  const before = lock({ "git@x": { resolution: { repo: "before" } } }),
    after = lock({ "git@x": { resolution: { repo: "after" } } });
  assert.equal(introducedPackages(before, after).length, 1);
});
test("security intent routes young artifacts to advisory-backed review without changing their age result", async () => {
  const report = await audit({ "lucide-react@1.56.0": record }, { securityIntent: true });
  assert.equal(report.state, "waiting");
  assert.equal(report.findings[0].state, "young");
  assert.equal(report.route, "advisory-backed-controlled-review-required");
});
test("actual age CLI retains oversized Unicode evidence and bounds the complete output", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "age-cli-"));
  const git = (args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  try {
    git(["init"]);
    git(["config", "user.email", "fixture@example.invalid"]);
    git(["config", "user.name", "Fixture"]);
    writeFileSync(path.join(root, "pnpm-lock.yaml"), lock({}));
    git(["add", "."]);
    git(["commit", "-m", "base"]);
    const base = git(["rev-parse", "HEAD"]).trim();
    writeFileSync(
      path.join(root, "pnpm-lock.yaml"),
      lock(
        Object.fromEntries(
          Array.from({ length: 1000 }, (_, i) => [
            `未知😀${i}${"界".repeat(40)}`,
            { resolution: { repo: "unsupported" } },
          ]),
        ),
      ),
    );
    git(["add", "."]);
    git(["commit", "-m", "candidate"]);
    const head = git(["rev-parse", "HEAD"]).trim();
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("./dependency-release-age.mjs", import.meta.url)),
        "--base",
        base,
        "--head",
        head,
      ],
      { cwd: root, encoding: "utf8", env: { ...process.env, GITHUB_EVENT_PATH: "" } },
    );
    assert.equal(result.status, 2, result.stderr);
    assert(Buffer.byteLength(result.stdout) <= 16 * 1024);
    assert.match(result.stdout, /omitted: [1-9]/u);
    const reference = result.stdout
      .split("\n")
      .find((line) => line.startsWith("Raw evidence: "))
      .slice("Raw evidence: ".length);
    const raw = JSON.parse(readFileSync(reference, "utf8"));
    assert.equal(raw.head, head);
    assert.equal(raw.findings.length, 1000);
    assert.equal(raw.state, "unknown");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

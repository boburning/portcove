import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyRenovateSnapshot,
  fastLanePolicyErrors,
  fastLaneSummary,
  metadataPlan,
  parseRenovateUpdates,
  validateDependencyDelta,
  validateCargoAuthority,
  validateNpmAuthority,
} from "./renovate-fast-lane.mjs";

const head = "a".repeat(40);
const base = "b".repeat(40);
const target = "c".repeat(40);
const required = ["catalog", "dependency-review", "frontend", "rust", "rust-quality"];

const config = {
  automerge: false,
  minimumReleaseAge: "3 days",
  minimumReleaseAgeBehaviour: "timestamp-required",
  internalChecksFilter: "strict",
  packageRules: [
    { matchPackageNames: ["react", "react-dom"], groupName: "react" },
    { matchPackageNames: ["/^@tauri-apps\\//", "/^tauri(?:-|$)/"], groupName: "tauri" },
  ],
};

function body({
  packageName = "crc32fast",
  dependencyType = "dependencies",
  updateType = "patch",
  currentVersion = "1.5.1",
  newVersion = "1.5.2",
} = {}) {
  return `This PR contains the following updates:

| Package | Type | Update | Change |
|---|---|---|---|
| [${packageName}](https://example.test/${packageName}) | ${dependencyType} | ${updateType} | \`${currentVersion}\` → \`${newVersion}\` |

---

### Release Notes
`;
}

function snapshot(overrides = {}) {
  const { pull: pullOverrides, ...snapshotOverrides } = overrides;
  const pull = {
    number: 7,
    state: "open",
    merged: false,
    draft: false,
    mergeable: true,
    title: "fix(deps): update rust crate crc32fast to 1.5.2",
    body: body(),
    labels: [{ name: "dependencies" }],
    user: { login: "renovate[bot]" },
    head: { sha: head, ref: "renovate/crc32fast-1.x" },
    base: { sha: base, ref: "main" },
    ...(pullOverrides ?? {}),
  };
  return {
    commits: [{ sha: head, author: { login: "renovate[bot]" } }],
    files: [
      { filename: "Cargo.toml", status: "modified" },
      { filename: "Cargo.lock", status: "modified" },
    ],
    contexts: required.map((context) => ({
      context,
      outcome: "success",
      conclusion: "success",
    })),
    statuses: [
      {
        context: "renovate/stability-days",
        state: "success",
        description: "Updates have met minimum release age requirement",
      },
    ],
    config,
    expectedHead: head,
    baseEvidence: {
      currentTarget: target,
      currentMergeBase: base,
      targetPaths: ["docs/README.md"],
      targetDependencyPaths: [],
    },
    ...snapshotOverrides,
    pull,
  };
}

function classify(overrides = {}) {
  return classifyRenovateSnapshot(snapshot(overrides));
}

test("parses current Renovate tables with and without dependency type columns", () => {
  assert.deepEqual(parseRenovateUpdates(body()), [
    {
      packageName: "crc32fast",
      dependencyType: "dependencies",
      updateType: "patch",
      currentVersion: "1.5.1",
      newVersion: "1.5.2",
    },
  ]);
  const noType = body()
    .replace("| Package | Type | Update | Change |", "| Package | Update | Change |")
    .replace("|---|---|---|---|", "|---|---|---|")
    .replace(" | dependencies | patch |", " | patch |");
  assert.equal(parseRenovateUpdates(noType)[0].dependencyType, null);
  assert.deepEqual(parseRenovateUpdates("not a Renovate body"), []);
});

test("fast lane requires the checked-in non-automerge release-age policy", () => {
  assert.deepEqual(fastLanePolicyErrors(config), []);
  for (const [key, value] of [
    ["automerge", true],
    ["minimumReleaseAge", "0 days"],
    ["minimumReleaseAgeBehaviour", "timestamp-optional"],
    ["internalChecksFilter", "flexible"],
  ]) {
    assert.ok(
      fastLanePolicyErrors({ ...config, [key]: value }).some((error) => error.includes(key)),
    );
  }
});

test("ordinary stable Cargo and npm patch or minor updates reach metadata validation", () => {
  const cargo = classify();
  assert.equal(cargo.verdict, "metadata-required");
  assert.equal(cargo.evidence.manager, "cargo");

  const npm = classify({
    pull: {
      body: body({ packageName: "lucide-react", updateType: "minor", newVersion: "1.46.0" }),
    },
    files: [
      { filename: "apps/desktop/package.json", status: "modified" },
      { filename: "pnpm-lock.yaml", status: "modified" },
    ],
  });
  assert.equal(npm.verdict, "metadata-required");
  assert.equal(npm.evidence.manager, "npm");
});

test("identity and exact-head violations reject or leave the fast lane", () => {
  assert.equal(classify({ pull: { user: { login: "maintainer" } } }).verdict, "reject");
  assert.equal(classify({ expectedHead: "d".repeat(40) }).verdict, "reject");
  assert.equal(
    classify({ commits: [{ sha: head, author: { login: "maintainer" } }] }).verdict,
    "manual-review-required",
  );
  assert.equal(classify({ pull: { state: "closed" } }).verdict, "reject");
  assert.equal(classify({ pull: { base: { sha: base, ref: "release" } } }).verdict, "reject");
});

test("grouped security pre-1.0 major and configured ecosystem updates stay manual", () => {
  const second = body({ packageName: "other", currentVersion: "2.0.0", newVersion: "2.0.1" })
    .split("\n")
    .find((line) => line.startsWith("| [other]"));
  const groupedBody = body().replace("\n\n---", `\n${second}\n\n---`);
  for (const pull of [
    { body: groupedBody },
    { body: body({ currentVersion: "0.9.0", newVersion: "0.9.1" }) },
    { body: body({ currentVersion: "1.5.1-beta.1", newVersion: "1.5.1" }) },
    { body: body({ updateType: "major", newVersion: "2.0.0" }) },
    { body: body({ updateType: "patch", newVersion: "1.6.0" }) },
    { body: body({ updateType: "minor", newVersion: "1.5.2" }) },
    { body: body({ updateType: "patch", newVersion: "1.5.0" }) },
    { body: body({ packageName: "react", currentVersion: "19.3.0", newVersion: "19.4.0" }) },
    { body: `${body()}\nVulnerability Alert`, labels: [{ name: "security" }] },
    { title: "fix(deps): update rust crate crc32fast to 1.5.2 [SECURITY]" },
    { head: { sha: head, ref: "renovate/security/crc32fast-1.x" } },
  ]) {
    assert.equal(classify({ pull }).verdict, "manual-review-required");
  }
});

test("unexpected file forms and npm dependency types stay manual", () => {
  for (const files of [
    [{ filename: "Cargo.lock", status: "modified" }],
    [
      { filename: "Cargo.toml", status: "modified" },
      { filename: "Cargo.lock", status: "modified" },
      { filename: "crates/portcove-core/src/lib.rs", status: "modified" },
    ],
    [
      { filename: "Cargo.toml", status: "modified" },
      { filename: "crates/portcove-core/Cargo.toml", status: "modified" },
      { filename: "Cargo.lock", status: "modified" },
    ],
    [
      { filename: "apps/desktop/package.json", status: "modified" },
      { filename: "pnpm-lock.yaml", status: "added" },
    ],
    [
      { filename: "rust-toolchain.toml", status: "modified" },
      { filename: "Cargo.lock", status: "modified" },
    ],
    [
      { filename: ".github/workflows/ci.yml", status: "modified" },
      { filename: "Cargo.lock", status: "modified" },
    ],
    [
      { filename: "aqua.yaml", status: "modified" },
      { filename: "aqua-checksums.json", status: "modified" },
    ],
  ]) {
    assert.equal(classify({ files }).verdict, "manual-review-required");
  }
  assert.equal(
    classify({
      pull: { body: body({ packageName: "react", dependencyType: "peerDependencies" }) },
      files: [
        { filename: "apps/desktop/package.json", status: "modified" },
        { filename: "pnpm-lock.yaml", status: "modified" },
      ],
      config: { ...config, packageRules: [] },
    }).verdict,
    "manual-review-required",
  );
});

test("metadata authority accepts registries and rejects Git or custom sources", () => {
  const registryMetadata = JSON.stringify({
    packages: [
      {
        dependencies: [
          { name: "crc32fast", source: "registry+https://github.com/rust-lang/crates.io-index" },
        ],
      },
    ],
  });
  assert.doesNotThrow(() => validateCargoAuthority(registryMetadata, "crc32fast"));
  assert.throws(
    () =>
      validateCargoAuthority(
        JSON.stringify({
          packages: [
            {
              dependencies: [{ name: "crc32fast", source: "git+https://example.test/crc32fast" }],
            },
          ],
        }),
        "crc32fast",
      ),
    /not exclusively registry-backed/,
  );
  assert.doesNotThrow(() =>
    validateNpmAuthority({ dependencies: { "lucide-react": "^1.46.0" } }, "lucide-react"),
  );
  assert.throws(
    () =>
      validateNpmAuthority(
        { dependencies: { "lucide-react": "github:owner/repository" } },
        "lucide-react",
      ),
    /not one ordinary registry-backed/,
  );
});

test("dependency delta binds the claimed package and versions to manifest and lock changes", () => {
  const cargo = {
    manager: "cargo",
    packageName: "crc32fast",
    currentVersion: "1.5.1",
    newVersion: "1.5.2",
    baseManifest: '[workspace.dependencies]\ncrc32fast = "1.5.1"\nother = "2.0.0"\n',
    headManifest: '[workspace.dependencies]\ncrc32fast = "1.5.2"\nother = "2.0.0"\n',
    baseLock: '[[package]]\nname = "crc32fast"\nversion = "1.5.1"\n',
    headLock: '[[package]]\nname = "crc32fast"\nversion = "1.5.2"\n',
  };
  assert.doesNotThrow(() => validateDependencyDelta(cargo));
  assert.throws(
    () => validateDependencyDelta({ ...cargo, packageName: "other" }),
    /manifest delta/,
  );
  assert.throws(
    () => validateDependencyDelta({ ...cargo, currentVersion: "1.5.0" }),
    /manifest delta/,
  );
  assert.throws(() => validateDependencyDelta({ ...cargo, newVersion: "1.5.3" }), /manifest delta/);
  assert.throws(
    () => validateDependencyDelta({ ...cargo, headLock: cargo.baseLock }),
    /lock delta/,
  );
  assert.throws(
    () =>
      validateDependencyDelta({
        ...cargo,
        headManifest: '[workspace.dependencies]\ncrc32fast = "1.5.2"\nother = "2.0.1"\n',
      }),
    /not the only manifest change/,
  );

  const npm = {
    manager: "npm",
    packageName: "lucide-react",
    currentVersion: "1.45.0",
    newVersion: "1.46.0",
    baseManifest: JSON.stringify({ dependencies: { "lucide-react": "^1.45.0" } }),
    headManifest: JSON.stringify({ dependencies: { "lucide-react": "^1.46.0" } }),
    baseLock: "packages:\n\n  lucide-react@1.45.0:\n",
    headLock: "packages:\n\n  lucide-react@1.46.0:\n",
  };
  assert.doesNotThrow(() => validateDependencyDelta(npm));
  assert.throws(
    () =>
      validateDependencyDelta({
        ...npm,
        baseManifest: JSON.stringify({
          dependencies: { "lucide-react": "^1.45.0", other: "2.0.0" },
        }),
        headManifest: JSON.stringify({
          dependencies: { "lucide-react": "^1.46.0", other: "2.0.1" },
        }),
      }),
    /not the only manifest change/,
  );
});

test("current-base manifest workflow and policy interactions stay manual", () => {
  for (const targetPath of [
    "Cargo.toml",
    "crates/portcove-core/Cargo.toml",
    ".github/workflows/ci.yml",
    "renovate.json",
    ".github/repository-ruleset.json",
    "scripts/renovate-fast-lane.mjs",
    "scripts/pr-delivery.mjs",
  ]) {
    const result = classify({
      baseEvidence: { currentTarget: target, currentMergeBase: base, targetPaths: [targetPath] },
    });
    assert.equal(result.verdict, "manual-review-required", targetPath);
    assert.deepEqual(result.evidence.target_paths, [targetPath]);
  }
  for (const targetPath of ["pnpm-lock.yaml", "pnpm-workspace.yaml", "package.json"]) {
    const result = classify({
      pull: {
        body: body({ packageName: "lucide-react", updateType: "minor", newVersion: "1.46.0" }),
      },
      files: [
        { filename: "apps/desktop/package.json", status: "modified" },
        { filename: "pnpm-lock.yaml", status: "modified" },
      ],
      baseEvidence: { currentTarget: target, currentMergeBase: base, targetPaths: [targetPath] },
    });
    assert.equal(result.verdict, "manual-review-required", targetPath);
    assert.deepEqual(result.evidence.target_paths, [targetPath]);
  }
  const dependencyInteraction = classify({
    baseEvidence: {
      currentTarget: target,
      currentMergeBase: base,
      targetPaths: ["crates/portcove-core/src/source.rs"],
      targetDependencyPaths: ["crates/portcove-core/src/source.rs"],
    },
  });
  assert.equal(dependencyInteraction.verdict, "manual-review-required");
  assert.deepEqual(dependencyInteraction.evidence.target_paths, [
    "crates/portcove-core/src/source.rs",
  ]);
});

test("pending failed missing and successful remote gates produce bounded verdicts", () => {
  assert.equal(classify({ pull: { draft: true } }).verdict, "waiting");
  assert.equal(classify({ pull: { mergeable: null } }).verdict, "waiting");
  assert.equal(classify({ pull: { mergeable: false } }).verdict, "manual-review-required");
  assert.equal(
    classify({
      contexts: required.map((context, index) => ({
        context,
        outcome: index ? "success" : "pending",
        conclusion: index ? "success" : "missing",
      })),
    }).verdict,
    "waiting",
  );
  assert.equal(
    classify({
      contexts: required.map((context, index) => ({
        context,
        outcome: index ? "success" : "failure",
        conclusion: index ? "success" : "failure",
      })),
    }).verdict,
    "manual-review-required",
  );
  assert.equal(classify({ statuses: [] }).verdict, "manual-review-required");
  assert.equal(
    classify({ statuses: [{ context: "renovate/stability-days", state: "pending" }] }).verdict,
    "waiting",
  );
});

test("metadata plans contain no compilation lint or test suite commands", () => {
  const cargo = metadataPlan("cargo");
  assert.deepEqual(
    cargo.map((command) => command.id),
    ["cargo-metadata", "dependency-policy"],
  );
  const npm = metadataPlan("npm");
  assert.deepEqual(
    npm.map((command) => command.id),
    ["pnpm-lockfile"],
  );
  const rendered = JSON.stringify([...cargo, ...npm]);
  for (const forbidden of ["clippy", "cargo check", "nextest", "vitest", "local-check", "audit"])
    assert.doesNotMatch(rendered, new RegExp(forbidden, "u"));
});

test("human summary preserves the machine verdict and reason", () => {
  assert.equal(
    fastLaneSummary({ verdict: "waiting", reason: "minimum release age is still pending" }),
    "waiting: minimum release age is still pending",
  );
});

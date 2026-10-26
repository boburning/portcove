import type { RenovateSnapshot, RenovatePull } from "./renovate-fast-lane.mts";
import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyRenovateSnapshot,
  diagnoseRenovateReleaseAge,
  fastLanePolicyErrors,
  fastLaneSummary,
  metadataPlan,
  parseRenovateUpdates,
  validateDependencyDelta,
  validateCargoAuthority,
  validateNpmAuthority,
} from "./renovate-fast-lane.mts";

type SnapshotOverrides = Omit<Partial<RenovateSnapshot>, "pull"> & { pull?: Partial<RenovatePull> };
function requiredFixture<T>(value: T | undefined): T {
  assert.notEqual(value, undefined);
  if (value === undefined) throw new Error("Required fixture value is missing");
  return value;
}

const head = "a".repeat(40);
const base = "b".repeat(40);
const target = "c".repeat(40);
const required = ["catalog", "dependency-review", "frontend", "rust", "rust-quality"];

function cargoArtifact(name: string, version: string, checksum = "1".repeat(64)) {
  return `[[package]]\nname = "${name}"\nversion = "${version}"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "${checksum}"\n`;
}

function npmArtifact(version: string, integrity = "AAAA", extra = "") {
  return `packages:\n\n  lucide-react@${version}:\n    resolution: {integrity: sha512-${integrity}}\n${extra}`;
}

const config = {
  automerge: false,
  minimumReleaseAge: "1 day",
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

function snapshot(overrides: SnapshotOverrides = {}): RenovateSnapshot {
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

function classify(overrides: SnapshotOverrides = {}) {
  return classifyRenovateSnapshot(snapshot(overrides));
}

void test("parses current Renovate tables with and without dependency type columns", () => {
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
  assert.equal(requiredFixture(parseRenovateUpdates(noType)[0]).dependencyType, null);
  const noUpdate = body()
    .replace("| Package | Type | Update | Change |", "| Package | Type | Change |")
    .replace("|---|---|---|---|", "|---|---|---|")
    .replace(" | dependencies | patch |", " | dependencies |");
  assert.deepEqual(parseRenovateUpdates(noUpdate), []);
  assert.equal(classify({ pull: { body: noUpdate } }).verdict, "manual-review-required");
  assert.deepEqual(parseRenovateUpdates("not a Renovate body"), []);
});

void test("parses Renovate package source annotations without changing dependency identity", () => {
  // Observed in the natural i18next 26.4.7 proposal (#2057).
  const proposal = `| Package | Type | Update | Change | Age | Confidence |
|---|---|---|---|---|---|
| [i18next](https://www.i18next.com) ([source](https://redirect.github.com/i18next/i18next)) | dependencies | patch | \`26.4.6\` → \`26.4.7\` | 1 day | high |`;
  assert.deepEqual(parseRenovateUpdates(proposal), [
    {
      packageName: "i18next",
      dependencyType: "dependencies",
      updateType: "patch",
      currentVersion: "26.4.6",
      newVersion: "26.4.7",
    },
  ]);
  for (const packageName of ["@scope/package", "reqwest", "react"]) {
    const annotated = body({ packageName }).replace(
      `](https://example.test/${packageName})`,
      `](https://example.test/${packageName}) ([source](https://example.test/source))`,
    );
    assert.equal(requiredFixture(parseRenovateUpdates(annotated)[0]).packageName, packageName);
    if (packageName !== "@scope/package") {
      assert.equal(classify({ pull: { body: annotated } }).verdict, "manual-review-required");
    }
  }
});

void test("package source annotation parsing preserves unsupported or ambiguous cells", () => {
  const link = "[crc32fast](https://example.test/crc32fast)";
  for (const suffix of [
    " ([other](https://example.test/source))",
    " ([source](https://example.test/source)) extra",
    " ([source](https://example.test/source)) ([source](https://example.test/second))",
    " [other](https://example.test/other)",
    " ([source](https://example.test/source)",
    " ([source]())",
  ]) {
    const cell = link + suffix;
    assert.equal(
      requiredFixture(parseRenovateUpdates(body().replace(link, cell))[0]).packageName,
      cell,
    );
  }
  const annotated = body().replace(link, `${link} ([source](https://example.test/source))`);
  const row = requiredFixture(
    annotated.split("\n").find((line) => line.startsWith("| [crc32fast]")),
  );
  assert.equal(
    classify({ pull: { body: annotated.replace("\n\n---", `\n${row}\n\n---`) } }).verdict,
    "manual-review-required",
  );
});

void test("fast lane requires the checked-in non-automerge release-age policy", () => {
  assert.deepEqual(fastLanePolicyErrors(config), []);
  for (const [key, value] of [
    ["automerge", true],
    ["minimumReleaseAge", "0 days"],
    ["minimumReleaseAgeBehaviour", "timestamp-optional"],
    ["internalChecksFilter", "flexible"],
  ] as const) {
    assert.ok(
      fastLanePolicyErrors({ ...config, [key]: value }).some((error) => error.includes(key)),
    );
  }
});

void test("ordinary stable Cargo and npm patch or minor updates reach metadata validation", () => {
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

void test("identity and exact-head violations reject or leave the fast lane", () => {
  assert.equal(classify({ pull: { user: { login: "maintainer" } } }).verdict, "reject");
  assert.equal(classify({ expectedHead: "d".repeat(40) }).verdict, "reject");
  assert.equal(
    classify({ commits: [{ sha: head, author: { login: "maintainer" } }] }).verdict,
    "manual-review-required",
  );
  assert.equal(classify({ pull: { state: "closed" } }).verdict, "reject");
  assert.equal(classify({ pull: { base: { sha: base, ref: "release" } } }).verdict, "reject");
});

void test("grouped security pre-1.0 major and configured ecosystem updates stay manual", () => {
  const second = body({ packageName: "other", currentVersion: "2.0.0", newVersion: "2.0.1" })
    .split("\n")
    .find((line: string) => line.startsWith("| [other]"));
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

void test("unexpected file forms and npm dependency types stay manual", () => {
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

void test("metadata authority accepts registries and rejects Git or custom sources", () => {
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

void test("dependency delta binds the claimed package and versions to manifest and lock changes", () => {
  const cargo = {
    manager: "cargo",
    packageName: "crc32fast",
    currentVersion: "1.5.1",
    newVersion: "1.5.2",
    baseManifest: '[workspace.dependencies]\ncrc32fast = "1.5.1"\nother = "2.0.0"\n',
    headManifest: '[workspace.dependencies]\ncrc32fast = "1.5.2"\nother = "2.0.0"\n',
    baseLock: cargoArtifact("crc32fast", "1.5.1"),
    headLock: cargoArtifact("crc32fast", "1.5.2", "2".repeat(64)),
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
  assert.throws(
    () =>
      validateDependencyDelta({
        ...cargo,
        baseManifest: '[workspace.dependencies]\ncrc32fast = "^1.5.1"\nother = "2.0.0"\n',
        headManifest: '[workspace.dependencies]\ncrc32fast = "~1.5.2"\nother = "2.0.0"\n',
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
    baseLock: npmArtifact("1.45.0"),
    headLock: npmArtifact("1.46.0", "BBBB"),
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
  assert.throws(
    () =>
      validateDependencyDelta({
        ...npm,
        baseManifest: JSON.stringify({ dependencies: { "lucide-react": "^1.45.0" } }),
        headManifest: JSON.stringify({ dependencies: { "lucide-react": "~1.46.0" } }),
      }),
    /not the only manifest change/,
  );
});

void test("small stable signing trust credential archive and persistent-data changes require controlled review", () => {
  for (const packageName of [
    "minisign",
    "minisign-verify",
    "tough",
    "ed25519-dalek",
    "aws-lc-rs",
    "sha2",
    "sha1",
    "keyring",
    "rpassword",
    "reqwest",
    "url",
    "zip",
    "tar",
    "flate2",
    "rusqlite",
    "rustix",
    "tempfile",
  ]) {
    const result = classify({
      pull: { body: body({ packageName, currentVersion: "2.0.0", newVersion: "2.0.1" }) },
    });
    assert.equal(result.verdict, "manual-review-required", packageName);
    assert.match(result.reason, /security-sensitive or persistent-data/);
  }
});

void test("whole Cargo lock review refuses hidden transitive source feature and integrity changes", () => {
  const change = {
    manager: "cargo",
    packageName: "crc32fast",
    currentVersion: "1.5.1",
    newVersion: "1.5.2",
    baseManifest: 'crc32fast = { version = "1.5.1", features = ["std"] }\n',
    headManifest: 'crc32fast = { version = "1.5.2", features = ["std"] }\n',
    baseLock: cargoArtifact("crc32fast", "1.5.1") + cargoArtifact("other", "2.0.0"),
    headLock: cargoArtifact("crc32fast", "1.5.2", "2".repeat(64)) + cargoArtifact("other", "2.0.0"),
  };
  assert.doesNotThrow(() => validateDependencyDelta(change));
  for (const headLock of [
    change.headLock.replace(
      'name = "other"\nversion = "2.0.0"',
      'name = "other"\nversion = "2.0.1"',
    ),
    change.headLock + cargoArtifact("new-build-script", "1.0.0"),
    change.headLock.replace(
      'name = "other"\nversion = "2.0.0"',
      'name = "other"\nversion = "2.0.0"\nfeatures = ["new"]',
    ),
    change.headLock.replaceAll(
      'checksum = "' + "1".repeat(64) + '"',
      'checksum = "' + "3".repeat(64) + '"',
    ),
  ])
    assert.throws(() => validateDependencyDelta({ ...change, headLock }), /resolved lock graph/);
  assert.throws(
    () =>
      validateDependencyDelta({
        ...change,
        headLock: change.headLock.replace(
          "registry+https://github.com/rust-lang/crates.io-index",
          "git+https://example.test/repo",
        ),
      }),
    /registry/,
  );
  assert.throws(
    () =>
      validateDependencyDelta({
        ...change,
        headManifest: change.headManifest.replace('["std"]', '["different"]'),
      }),
    /only manifest/,
  );
});

void test("pnpm masking is confined to the direct artifact and importer entry, including sibling versions", () => {
  const importer = (direct: string, sibling: string) =>
    `importers:\n  apps/desktop:\n    dependencies:\n      lucide-react:\n        specifier: ^${direct}\n        version: ${direct}(react@19.3.0)\n      other:\n        specifier: ^1.45.0\n        version: ${sibling}\n`;
  const unchanged =
    "\n  other@1.45.0:\n    resolution: {integrity: sha512-CCCC}\n\n  other@1.46.0:\n    resolution: {integrity: sha512-DDDD}\n";
  const change = {
    manager: "npm",
    packageName: "lucide-react",
    currentVersion: "1.45.0",
    newVersion: "1.46.0",
    baseManifest: JSON.stringify({ dependencies: { "lucide-react": "^1.45.0", other: "^1.45.0" } }),
    headManifest: JSON.stringify({ dependencies: { "lucide-react": "^1.46.0", other: "^1.45.0" } }),
    baseLock: importer("1.45.0", "1.45.0") + npmArtifact("1.45.0") + unchanged,
    headLock: importer("1.46.0", "1.45.0") + npmArtifact("1.46.0", "BBBB") + unchanged,
  };
  assert.doesNotThrow(() => validateDependencyDelta(change));
  const siblingChanged = importer("1.46.0", "1.46.0") + npmArtifact("1.46.0", "BBBB") + unchanged;
  assert.throws(
    () => validateDependencyDelta({ ...change, headLock: siblingChanged }),
    /resolved lock graph/,
  );
  assert.throws(
    () =>
      validateDependencyDelta({
        ...change,
        headLock: change.headLock.replace("sha512-CCCC", "sha512-EEEE"),
      }),
    /resolved lock graph/,
  );
  for (const extra of [
    "    engines: {node: '>=28'}\n",
    "    hasBin: true\n",
    "    dependencies: {new: 1.0.0}\n",
  ])
    assert.throws(
      () =>
        validateDependencyDelta({
          ...change,
          headLock: importer("1.46.0", "1.45.0") + npmArtifact("1.46.0", "BBBB", extra) + unchanged,
        }),
      /resolved lock graph/,
    );
  assert.throws(
    () =>
      validateDependencyDelta({
        ...change,
        headLock: change.headLock.replace(
          "{integrity: sha512-BBBB}",
          "{tarball: https://unreviewed.test/package.tgz}",
        ),
      }),
    /registry\/integrity/,
  );
  assert.doesNotThrow(() =>
    validateDependencyDelta({ ...change, headLock: change.headLock.replaceAll("\n", "\r\n") }),
  );
  for (const name of ["not-lucide-react", "@scope/lucide-react"]) {
    assert.throws(
      () =>
        validateDependencyDelta({
          ...change,
          baseLock: change.baseLock + `snapshots:\n  '${name}@1.45.0': {}\n`,
          headLock: change.headLock + `snapshots:\n  '${name}@1.46.0': {}\n`,
        }),
      /resolved lock graph/,
    );
  }
});

void test("current-base manifest workflow and policy interactions stay manual", () => {
  for (const targetPath of [
    "Cargo.toml",
    "crates/portcove-core/Cargo.toml",
    ".github/workflows/ci.yml",
    "renovate.json",
    ".github/repository-ruleset.json",
    ...[
      "ci-result-gate",
      "select-ci-plan",
      "validation-plan",
      "renovate-fast-lane",
      "pr-delivery",
    ].flatMap((name) => [`scripts/${name}.mjs`, `scripts/${name}.mts`]),
  ]) {
    const result = classify({
      baseEvidence: { currentTarget: target, currentMergeBase: base, targetPaths: [targetPath] },
    });
    assert.equal(result.verdict, "manual-review-required", targetPath);
    assert.ok("target_paths" in result.evidence);
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
    assert.ok("target_paths" in result.evidence);
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
  assert.ok("target_paths" in dependencyInteraction.evidence);
  assert.deepEqual(dependencyInteraction.evidence.target_paths, [
    "crates/portcove-core/src/source.rs",
  ]);
});

void test("pending failed missing and successful remote gates produce bounded verdicts", () => {
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

void test("metadata plans contain no compilation lint or test suite commands", () => {
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

void test("human summary preserves the machine verdict and reason", () => {
  assert.equal(
    fastLaneSummary({ verdict: "waiting", reason: "minimum release age is still pending" }),
    "waiting: minimum release age is still pending",
  );
});

void test("age diagnosis does not turn an unexplained pending digest into verified youth or eligibility", () => {
  const body =
    "| Package | Update | Change |\n|---|---|---|\n| ubuntu | digest | `old` → `new` |\n\n" +
    `<!--renovate-debug:${Buffer.from(JSON.stringify({ updatedInVer: "44.180.0" })).toString("base64")}-->`;
  const diagnosis = diagnoseRenovateReleaseAge(
    [
      {
        context: "renovate/stability-days",
        state: "pending",
        description: "Updates have not met minimum release age requirement",
      },
    ],
    body,
  );
  assert.equal(diagnosis.classification, "pending-unexplained");
  assert.equal(diagnosis.observed_bot_version, "44.180.0");
  assert.match(diagnosis.bot_version_boundary, /current hosted deployment is not established/);
  assert.match(diagnosis.next_action, /pending alone does not prove a young release/);
  assert.equal(diagnosis.upstream_issue, "https://github.com/renovatebot/renovate/issues/45236");
  assert.match(diagnosis.upstream_match ?? "", /not a confirmed/);
});

void test("age diagnosis preserves missing conflicting failed and explicit missing-timestamp evidence", () => {
  const status = (state: string, description?: string) => ({
    context: "renovate/stability-days",
    state,
    description: description ?? null,
  });
  assert.equal(diagnoseRenovateReleaseAge([], "").classification, "missing");
  assert.equal(
    diagnoseRenovateReleaseAge([status("success"), status("pending")], "").classification,
    "ambiguous",
  );
  for (const state of ["failure", "error"])
    assert.equal(diagnoseRenovateReleaseAge([status(state)], "").classification, "failed");
  assert.equal(diagnoseRenovateReleaseAge([status("success")], "").classification, "passed");
  assert.equal(
    diagnoseRenovateReleaseAge([status("pending", "release timestamp unavailable")], "")
      .classification,
    "timestamp-unavailable",
  );
  assert.equal(
    diagnoseRenovateReleaseAge([status("pending", "unknown releaseTimestamp")], "").classification,
    "timestamp-unavailable",
  );
});

void test("optional bot debug metadata fails closed and update hints require actual table metadata", () => {
  const age = [{ context: "renovate/stability-days", state: "pending" }];
  const marker = (value: unknown) =>
    `<!--renovate-debug:${Buffer.from(JSON.stringify(value)).toString("base64")}-->`;
  for (const body of [
    "<!--renovate-debug:eA==-->",
    marker({ updatedInVer: 44180 }),
    marker({ updatedInVer: "latest" }),
    marker({ updatedInVer: "44.180.0" }) + "\n" + marker({ updatedInVer: "44.171.2" }),
  ])
    assert.equal(diagnoseRenovateReleaseAge(age, body).observed_bot_version, null);
  assert.equal(
    diagnoseRenovateReleaseAge(
      age,
      "| Update | Change |\n|---|---|\n| lockFileMaintenance | All locks refreshed |\n",
    ).upstream_issue,
    "https://github.com/renovatebot/renovate/issues/45236",
  );
  assert.equal(
    diagnoseRenovateReleaseAge(age, "digest lockFileMaintenance mentioned only in release notes")
      .upstream_issue,
    null,
  );
});

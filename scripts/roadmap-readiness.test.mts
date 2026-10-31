import { catalogQualificationSummary } from "./roadmap-qualification.mts";
import { validateApproval706 } from "./linux-beta-risk-706.mts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  analyzeReleaseReadiness,
  inspectReadinessReleaseProfile,
  renderReadinessSummary,
  completionEvidenceLinks,
  dependencyCycles,
  renderSnapshot,
  resolveSnapshotOutput,
} from "./roadmap-readiness.mts";
import { parseArguments } from "./roadmap.mts";

import { fixtureValue, fixtureElement } from "./fixtures/roadmap-fixtures.mts";

void test("catalog summary and release snapshot derive qualification data from catalog JSON", () => {
  const catalog = {
    ports: [
      {
        id: "one",
        support_tier: "stable",
        platforms: ["windows", "linux"],
        automated_tested_platforms: ["windows"],
        manually_validated_platforms: ["windows"],
      },
      {
        id: "two",
        support_tier: "beta",
        platforms: ["windows"],
        automated_tested_platforms: [],
        manually_validated_platforms: [],
      },
    ],
  };
  assert.deepEqual(catalogQualificationSummary(catalog), {
    ports: 2,
    byTier: { stable: 1, beta: 1 },
    declaredPlatformPairs: 3,
    automatedPlatformPairs: 1,
    manuallyValidatedPlatformPairs: 1,
  });
  const document = renderSnapshot({
    release: "Alpha 1",
    generatedAt: "2026-09-03T12:00:00.000Z",
    commit: "abcdef",
    projectUrl: "https://github.com/users/boburning/projects/1",
    items: [
      {
        title: "Trust",
        status: "Blocked",
        priority: "Urgent",
        horizon: "Now",
        type: "Security",
        "target release": "Alpha 1",
        "release commitment": "Required",
        content: { url: "https://github.com/boburning/portcove/issues/1" },
      },
    ],
    catalog,
  });
  assert.match(document, /## Open blockers[\s\S]*Trust/);
  assert.match(document, /Catalog entries: 2/);
  assert.match(document, /This snapshot does not grant qualification/);
});

void test("release snapshots are cumulative and Project Status alone authorizes completion", () => {
  const items = [
    {
      title: "Alpha blocker",
      status: "Blocked",
      "target release": "Alpha 1",
      "release commitment": "Required",
      content: {
        state: "OPEN",
        url: "https://github.com/boburning/portcove/issues/1",
        body: "Upstream https://example.test/not-evidence",
      },
    },
    {
      title: "Closed not planned",
      status: "Deferred",
      "target release": "Alpha 2",
      "release commitment": "Required",
      content: {
        state: "CLOSED",
        url: "https://github.com/boburning/portcove/issues/2",
        body: "## Completion evidence\n\nNone.",
      },
    },
    {
      title: "Beta complete",
      status: "Done",
      "target release": "Beta 1",
      "release commitment": "Required",
      content: {
        state: "CLOSED",
        url: "https://github.com/boburning/portcove/issues/3",
        body: "## Completion evidence\n\nhttps://github.com/boburning/portcove/pull/12",
      },
    },
    {
      title: "Later beta",
      status: "Ready",
      "target release": "Beta 2",
      "release commitment": "Required",
      content: {
        state: "OPEN",
        url: "https://github.com/boburning/portcove/issues/4",
      },
    },
  ];
  const document = renderSnapshot({
    release: "Beta 1",
    generatedAt: "2026-09-03T00:00:00Z",
    commit: "abc",
    projectUrl: "https://example.test/project",
    items,
    catalog: { ports: [] },
  });
  assert.match(document, /Cumulative required stages: Alpha 1, Alpha 2, Alpha 3, Beta 1/);
  assert.match(document, /## Open blockers[\s\S]*Alpha blocker/);
  assert.match(document, /## Completed required items[\s\S]*Beta complete/);
  assert.match(document, /## Unfinished required items[\s\S]*Closed not planned/);
  assert.match(
    document,
    /## Repository closure and Project Status inconsistencies[\s\S]*Closed not planned/,
  );
  assert.doesNotMatch(document, /Later beta/);
  assert.doesNotMatch(document, /example\.test\/not-evidence/);
  assert.match(document, /portcove\/pull\/12/);
});

void test("release readiness separates required, opportunistic, unclassified, and genuine blocking dependencies", () => {
  const issue = (
    number: number,
    title: string,
    fields: Record<string, string> = {},
    blockedBy: number[] = [],
    parent: number | null = null,
  ) => ({
    id: `item-${number}`,
    title,
    ...fields,
    content: {
      number,
      title,
      state: fields.status === "Done" ? "CLOSED" : "OPEN",
      url: `https://github.com/boburning/portcove/issues/${number}`,
      blockedBy: {
        nodes: blockedBy.map((dependency) => ({
          number: dependency,
          title: `Issue ${dependency}`,
          state: "OPEN",
          url: `https://github.com/boburning/portcove/issues/${dependency}`,
        })),
      },
      parent: parent ? { number: parent } : null,
    },
  });
  const items = [
    issue(
      1,
      "Required outcome",
      {
        status: "Ready",
        "target release": "Alpha 2",
        "release commitment": "Required",
        "work type": "Product feature",
      },
      [2],
    ),
    issue(2, "Misclassified dependency", {
      status: "Ready",
      "target release": "Post-V1",
      "release commitment": "Opportunistic",
      "work type": "Product feature",
    }),
    issue(3, "Optional slice", {
      status: "Ready",
      "target release": "Alpha 2",
      "release commitment": "Opportunistic",
      "work type": "Product feature",
    }),
    issue(4, "Unclassified release work", {
      status: "Ready",
      "target release": "Alpha 2",
      "work type": "Product feature",
    }),
    issue(5, "Unrelated intake", {
      status: "Inbox",
      "target release": "Unscheduled",
      "work type": "Port",
    }),
    issue(6, "Misclassified safety failure", {
      status: "Blocked",
      "target release": "Alpha 2",
      "release commitment": "Opportunistic",
      "work type": "Security",
    }),
    issue(
      7,
      "Child but not blocker",
      {
        status: "Ready",
        "target release": "Post-V1",
        "release commitment": "Opportunistic",
        "work type": "Product feature",
      },
      [],
      1,
    ),
  ];
  const analysis = analyzeReleaseReadiness(items, "Alpha 2");
  assert.deepEqual(
    analysis.effectiveRequired
      .map((item) => fixtureValue(item.content).number)
      .sort((left, right) =>
        String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0,
      ),
    [1, 2, 6],
  );
  assert.deepEqual(
    analysis.opportunistic
      .map((item) => fixtureValue(item.content).number)
      .sort((left, right) =>
        String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0,
      ),
    [3, 6],
  );
  assert.deepEqual(
    analysis.relevantUnclassified.map((item) => fixtureValue(item.content).number),
    [4],
  );
  assert.deepEqual(
    analysis.safetyConflicts.map((item) => fixtureValue(item.content).number),
    [6],
  );
  assert.equal(analysis.dependencyConflicts.length, 1);
  assert.equal(
    fixtureValue(fixtureElement(analysis.dependencyConflicts, 0).dependency.content).number,
    2,
  );
  assert.equal(
    analysis.effectiveRequired.some((item) => fixtureValue(item.content).number === 7),
    false,
  );
  assert.equal(
    analysis.effectiveRequired.some((item) => fixtureValue(item.content).number === 5),
    false,
  );
  assert.equal(analysis.ready, false);
});

void test("dependency analysis reports cycles and Project-missing blockers", () => {
  const one = {
    id: "one",
    title: "One",
    status: "Ready",
    "target release": "Alpha 1",
    "release commitment": "Required",
    content: {
      number: 1,
      url: "https://github.com/boburning/portcove/issues/1",
      blockedBy: { nodes: [{ number: 2, title: "Two" }] },
    },
  };
  const two = {
    id: "two",
    title: "Two",
    status: "Ready",
    "target release": "Alpha 1",
    "release commitment": "Required",
    content: {
      number: 2,
      url: "https://github.com/boburning/portcove/issues/2",
      blockedBy: {
        nodes: [
          { number: 1, title: "One" },
          {
            number: 99,
            title: "Missing",
            url: "https://github.com/boburning/portcove/issues/99",
          },
        ],
      },
    },
  };
  assert.deepEqual(dependencyCycles([one, two]), [[1, 2, 1]]);
  const analysis = analyzeReleaseReadiness([one, two], "Alpha 1");
  assert.equal(analysis.missingProjectDependencies.length, 1);
  assert.equal(
    fixtureValue(fixtureElement(analysis.missingProjectDependencies, 0).dependency.content).number,
    99,
  );
  assert.equal(analysis.ready, false);
});

void test("readiness fails closed when a blocking-dependency page is truncated", () => {
  const item = {
    id: "one",
    title: "One",
    status: "Done",
    "target release": "Alpha 1",
    "release commitment": "Required",
    content: {
      number: 1,
      state: "CLOSED",
      url: "https://github.com/boburning/portcove/issues/1",
      blockedBy: { totalCount: 11, nodes: [] },
    },
  };
  const analysis = analyzeReleaseReadiness([item], "Alpha 1");
  assert.deepEqual(analysis.truncatedDependencies, [item]);
  assert.equal(analysis.ready, false);

  const unrelated = {
    ...item,
    id: "later",
    "target release": "Post-V1",
    "release commitment": "Opportunistic",
    content: { ...item.content, number: 2 },
  };
  const required = {
    ...item,
    content: { ...item.content, blockedBy: { totalCount: 0, nodes: [] } },
  };
  const scoped = analyzeReleaseReadiness([required, unrelated], "Alpha 1");
  assert.deepEqual(scoped.truncatedDependencies, []);
  assert.equal(scoped.ready, true);
});

void test("completion evidence excludes ordinary upstream URLs and accepts explicit or typed records", () => {
  const links = completionEvidenceLinks([
    {
      body: [
        "Upstream: https://github.com/vendor/game",
        "Implementation: https://github.com/boburning/portcove/pull/22",
        "Qualification: https://example.test/qualification/windows",
        "## Completion evidence",
        "https://example.test/evidence/result.json",
        "## Dependencies and blockers",
        "https://example.test/not-evidence",
      ].join("\n"),
    },
  ]);
  assert.deepEqual(links, [
    "https://example.test/evidence/result.json",
    "https://example.test/qualification/windows",
    "https://github.com/boburning/portcove/pull/22",
  ]);
});

void test("snapshot output is confined to docs/releases", () => {
  assert.match(resolveSnapshotOutput("docs/releases/alpha.md"), /docs[\\/]releases[\\/]alpha\.md$/);
  assert.throws(() => resolveSnapshotOutput("docs/alpha.md"), /must be under docs\/releases/);
  assert.throws(() => resolveSnapshotOutput("../outside.md"), /must be under docs\/releases/);
});

{
  const approval: unknown = JSON.parse(
    readFileSync(new URL("../.github/linux-beta-risk-706.json", import.meta.url), "utf8"),
  );
  validateApproval706(approval, "2026-10-15T01:21:44.000Z");
  assert.ok(
    typeof approval.reconfirmedHead === "string" && typeof approval.policySha256 === "string",
  );
  const canonicalApproval = {
    ...approval,
    reconfirmedHead: approval.reconfirmedHead,
    policySha256: approval.policySha256,
  };
  const now = "2026-10-16T00:00:00.000Z";
  const item = (n: number, deps: number[] = []) => ({
    id: `i${n}`,
    title: `Remediation ${n}`,
    status: "Blocked",
    platform: "Linux",
    "work type": "Security",
    "target release": "Public beta",
    "release commitment": "Planned",
    content: {
      number: n,
      state: "OPEN",
      url: `https://github.com/boburning/portcove/issues/${n}`,
      blockedBy: { totalCount: deps.length, nodes: deps.map((number) => ({ number })) },
    },
  });
  const items = () => [item(49, [706]), item(706)];
  const windowsProfile = "initial-beta-windows-x86_64-v1";
  void test("explicit Windows readiness excludes only canonical Linux auto-promotion and retains its planned disclosure", () => {
    let approvalReads = 0;
    const unusedApproval = new Proxy(
      {},
      {
        get() {
          approvalReads++;
          throw new Error("Linux approval must not be consumed");
        },
      },
    );
    const input = items();
    const result = analyzeReleaseReadiness(input, "Public beta", {
      releaseProfile: windowsProfile,
      risk706Approval: unusedApproval,
    });
    assert.equal(approvalReads, 0);
    assert.equal(result.releaseProfile, windowsProfile);
    assert.equal(result.ready, true);
    assert.deepEqual(result.effectiveRequired, []);
    assert.deepEqual(result.excludedLinuxRisk706, input);
    assert.deepEqual(result.planned, input);
    assert.deepEqual(result.pendingRiskDispositions, []);
    assert.equal(result.candidateDisposition706, null);
    assert.match(renderReadinessSummary(result), /initial-beta-windows-x86_64-v1/);
    assert.match(renderReadinessSummary(result), /excluded from automatic promotion/);
    assert.match(renderReadinessSummary(result), /No Linux risk disposition is consumed/);
    assert.ok(input.every((i) => i.status === "Blocked" && i["release commitment"] === "Planned"));
    const full = analyzeReleaseReadiness(input, "Public beta");
    const historical = analyzeReleaseReadiness(input, "Public beta", {
      releaseProfile: "initial-beta-win-linux",
    });
    for (const broader of [full, historical]) {
      assert.equal(broader.ready, false);
      assert.equal(broader.effectiveRequired.length, 2);
      assert.equal(broader.pendingRiskDispositions.length, 2);
      assert.deepEqual(broader.excludedLinuxRisk706, []);
    }
  });
  void test("Windows readiness preserves explicit Required roots, genuine Linux dependencies and shared security", () => {
    const root = { ...item(100, [49]), platform: "Windows", "release commitment": "Required" };
    const result = analyzeReleaseReadiness([root, ...items()], "Public beta", {
      releaseProfile: windowsProfile,
    });
    assert.equal(result.ready, false);
    assert.deepEqual(
      new Set(result.effectiveRequired.map((i) => fixtureValue(i.content).number)),
      new Set([49, 100, 706]),
    );
    assert.equal(result.unfinishedRequired.length, 3);
    assert.equal(result.dependencyConflicts.length, 2);
    assert.deepEqual(result.excludedLinuxRisk706, []);
    for (const input of [
      [{ ...item(49), "release commitment": "Required" }],
      [item(99)],
      [{ ...item(49), platform: "Windows" }],
      [{ ...item(49), content: { ...item(49).content, url: "https://example.test/issues/49" } }],
    ]) {
      const refused = analyzeReleaseReadiness(input, "Public beta", {
        releaseProfile: windowsProfile,
      });
      assert.equal(refused.ready, false);
      assert.deepEqual(refused.excludedLinuxRisk706, []);
    }
  });
  void test("readiness profile cannot alias platforms, change milestone scope or consume Linux risk evidence", () => {
    assert.deepEqual(
      parseArguments([
        "readiness",
        "--release",
        "Public beta",
        "--release-profile",
        windowsProfile,
      ]),
      {
        command: "readiness",
        options: { "--release": "Public beta", "--release-profile": windowsProfile },
        positionals: [],
      },
    );
    assert.throws(() => parseArguments(["readiness", "--release-profile"]), /requires a value/);
    for (const suffix of ["=refused", "=", "=full=refused"]) {
      const parsed = parseArguments([
        "readiness",
        "--release",
        "Public beta",
        `--release-profile=${windowsProfile}${suffix}`,
      ]);
      assert.equal(parsed.options["--release-profile"], `${windowsProfile}${suffix}`);
      assert.throws(
        () => inspectReadinessReleaseProfile(parsed.options["--release-profile"], "Public beta"),
        /profile/,
      );
    }
    assert.equal(
      parseArguments(["context", "--runner=literal=value"]).options["--runner"],
      "literal=value",
    );
    for (const profile of [
      "unknown",
      "initial-beta-windows",
      "initial-beta-windows-aarch64-v1",
      "",
      null,
    ])
      assert.throws(
        () => analyzeReleaseReadiness(items(), "Public beta", { releaseProfile: profile }),
        /profile/,
      );
    assert.throws(() => inspectReadinessReleaseProfile(windowsProfile, "1.0"), /Public beta/);
    assert.throws(
      () => inspectReadinessReleaseProfile(windowsProfile, "Public beta", true),
      /cannot consume/,
    );
    for (const packet of [{}, false, "refused"])
      assert.throws(
        () =>
          analyzeReleaseReadiness(items(), "Public beta", {
            releaseProfile: windowsProfile,
            risk706Evidence: packet,
          }),
        /cannot consume/,
      );
    assert.throws(
      () =>
        analyzeReleaseReadiness(items(), "Public beta", {
          releaseProfile: windowsProfile,
          candidateIssues: [49],
        }),
      /candidate issue scope/,
    );
  });
  function evidence() {
    const policy = { ...canonicalApproval, firstPublicationTag: "v0.1.0-beta.1" };
    const candidate = {
      head: "a".repeat(40),
      lockSha256: "b".repeat(64),
      target: "x86_64-unknown-linux-gnu",
      features: ["default", "tauri/custom-protocol"],
      productionChanges: "",
      reviewedHead: policy.reconfirmedHead,
    };
    const diagnostic = {
      type: "diagnostic",
      fields: {
        severity: "error",
        code: "unsound",
        advisory: { id: policy.advisory, package: "glib" },
        labels: [{ span: "glib 0.18.5 registry+https://github.com/rust-lang/crates.io-index" }],
      },
    };
    const summary = Object.fromEntries(
      ["advisories", "bans", "licenses", "sources"].map((g) => [
        g,
        { errors: g === "advisories" ? 1 : 0, warnings: 0, notes: 0, helps: 0 },
      ]),
    );
    return {
      risk706Approval: policy,
      now,
      risk706Evidence: {
        approval: policy,
        candidate,
        scan: {
          head: candidate.head,
          lockSha256: candidate.lockSha256,
          completedAt: now,
          complete: true,
          signal: null,
          error: null,
          exitCode: 1,
          unsoundAll: true,
          configSha256: policy.policySha256,
          sourceConfigSha256: policy.policySha256,
          sourceConfig: readFileSync(new URL("../deny.toml", import.meta.url), "utf8"),
          executionConfig: readFileSync(new URL("../deny.toml", import.meta.url), "utf8"),
          toolVersion: "cargo-deny 0.20.2",
          scope: "workspace-default-all-targets-all-checks",
          stdout: "",
          stderr: [diagnostic, { type: "summary", fields: summary }]
            .map((value) => JSON.stringify(value))
            .join("\n"),
        },
        releases: [],
        purpose: "release",
        publicationTag: policy.firstPublicationTag,
      },
    };
  }
  void test("approved remediation planning is valid but never establishes release eligibility", () => {
    assert.deepEqual(
      parseArguments(["readiness", "--release", "Public beta", "--linux-beta-706"]),
      {
        command: "readiness",
        positionals: [],
        options: { "--release": "Public beta", "--linux-beta-706": true },
      },
    );
    const result = analyzeReleaseReadiness(items(), "Public beta", { now });
    assert.equal(result.safetyConflicts.length, 0);
    assert.equal(result.dependencyConflicts.length, 0);
    assert.equal(result.pendingRiskDispositions.length, 2);
    assert.equal(result.ready, false);
    assert.match(renderReadinessSummary(result), /Pending:.*actual candidate/);
    const expired = analyzeReleaseReadiness(items(), "Public beta", {
      now: "2026-11-15T04:59:00.000Z",
    });
    assert.equal(expired.safetyConflicts.length, 0);
    assert.equal(expired.ready, false);
    assert.equal(expired.pendingRiskDispositions.length, 2);
    const expiredRelease = evidence();
    expiredRelease.now = "2026-11-15T04:59:00.000Z";
    assert.throws(
      () => analyzeReleaseReadiness(items(), "Public beta", expiredRelease),
      /not valid/,
    );

    for (const options of [{ now, risk706Approval: null }]) {
      assert.equal(
        analyzeReleaseReadiness(items(), "Public beta", options).safetyConflicts.length,
        2,
      );
    }
  });
  void test("only a fully revalidated release candidate can satisfy the scoped pending nodes", () => {
    const options = evidence();
    const result = analyzeReleaseReadiness(items(), "Public beta", options);
    assert.equal(result.ready, true);
    assert.equal(fixtureValue(result.candidateDisposition706).scanPassed, false);
    assert.equal(result.effectiveRequired.length, 2);
    assert.equal(result.unfinishedRequired.length, 0);
    assert.ok(items().every((i) => i.content.state === "OPEN"));
    for (const mutate of [
      (e: ReturnType<typeof evidence>["risk706Evidence"]) => {
        e.scan.complete = false;
      },
      (e: ReturnType<typeof evidence>["risk706Evidence"]) => {
        e.candidate.productionChanges = "crates/portcove-core/src/lib.rs";
      },
      (e: ReturnType<typeof evidence>["risk706Evidence"]) => {
        e.purpose = "qualification";
      },
    ]) {
      const changed = evidence();
      mutate(changed.risk706Evidence);
      assert.throws(() => analyzeReleaseReadiness(items(), "Public beta", changed));
    }
    assert.throws(() => analyzeReleaseReadiness(items(), "1.0", options));
  });
  void test("canonical scope and all other dependency checks remain enforced", () => {
    for (const change of [
      (i: ReturnType<typeof item>) => {
        i.platform = "Steam Deck";
      },
      (i: ReturnType<typeof item>) => {
        i.content.url = "https://example.test/706";
      },
      (i: ReturnType<typeof item>) => {
        i["release commitment"] = "Opportunistic";
      },
    ]) {
      const list = items();
      change(fixtureElement(list, 1));
      assert.equal(analyzeReleaseReadiness(list, "Public beta", { now }).safetyConflicts.length, 1);
    }
    assert.equal(analyzeReleaseReadiness(items(), "1.0", { now }).safetyConflicts.length, 2);
    assert.equal(
      analyzeReleaseReadiness(items(), "Public beta", { now, candidateIssues: [49] })
        .safetyConflicts.length,
      1,
    );
    const list = items();
    fixtureElement(list, 1).content.blockedBy = { totalCount: 1, nodes: [{ number: 999 }] };
    assert.equal(
      analyzeReleaseReadiness(list, "Public beta", evidence()).missingProjectDependencies.length,
      1,
    );
    fixtureElement(list, 1).content.blockedBy = { totalCount: 1, nodes: [{ number: 49 }] };
    const cycle = analyzeReleaseReadiness(list, "Public beta", evidence());
    assert.equal(cycle.cycles.length, 1);
    assert.equal(cycle.dependencyConflicts.length, 1);
    assert.equal(cycle.ready, false);
    const deck = item(215, [49]);
    deck.platform = "Steam Deck";
    deck["release commitment"] = "Required";
    assert.equal(
      analyzeReleaseReadiness([...items(), deck], "Public beta", evidence()).dependencyConflicts
        .length,
      1,
    );
  });
}

void test("snapshot inconsistency reporting preserves open, closed and merged status conflicts", () => {
  const items = ["OPEN", "CLOSED", "MERGED"].flatMap((state, index) =>
    ["Ready", "Done"].map((status, offset) => ({
      id: `item-${index}-${offset}`,
      title: `${state} ${status}`,
      status,
      "target release": "Alpha 1",
      "release commitment": "Required",
      content: {
        number: index * 2 + offset + 1,
        state,
        url: `https://github.com/boburning/portcove/issues/${index * 2 + offset + 1}`,
      },
    })),
  );
  const document = renderSnapshot({
    release: "Alpha 1",
    generatedAt: "2026-10-26T15:00:00Z",
    commit: "a".repeat(40),
    projectUrl: "https://example.test/project",
    items,
    catalog: { ports: [] },
  });
  const section = document
    .split("## Repository closure and Project Status inconsistencies\n\n")[1]
    ?.split("\n\n## ")[0];
  assert.ok(section);
  for (const name of ["OPEN Done", "CLOSED Ready", "MERGED Ready"])
    assert.ok(section.includes(name), name);
  for (const name of ["OPEN Ready", "CLOSED Done", "MERGED Done"])
    assert.ok(!section.includes(name), name);
});

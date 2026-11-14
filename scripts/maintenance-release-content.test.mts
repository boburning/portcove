import assert from "node:assert/strict";
import test from "node:test";
import {
  releaseContentAttention,
  releaseContentFacts,
  releaseContentFindings,
  releaseContentUnscannable,
  signalSummary,
} from "./maintenance-release-content.mts";
import { PERSISTENT_UNSCANNED, SIGNAL_CAP, targetsDigest } from "./release-content-scan.mts";

// Synthetic records only: no real package, file or game data.
const sha = (digit: string) => digit.repeat(64);
const record = (id: string, platform: string, overrides: Record<string, unknown> = {}) => ({
  key: `r2|github|up/${id}|v1|${id}-${platform}.zip|10`,
  id,
  platform,
  repository: `up/${id}`,
  tag: "v1",
  asset: `${id}-${platform}.zip`,
  sha256: sha("a"),
  entries: 3,
  heads_unread: 0,
  heads_truncated: false,
  rules: 2,
  signals: [] as unknown[],
  signal_count: 0,
  ...overrides,
});
const signal = {
  path: "data/game.z64",
  kind: "rom-or-disc-image",
  reason: "Nintendo 64 ROM image",
};
const unscanned = (id: string, platform: string, code: string) => ({
  id,
  platform,
  code,
  reason: `free text for ${code}`,
});

function report() {
  const flagged = record("alpha", "linux-x86-64", { signals: [signal], signal_count: 1 });
  // A reused finding comes from the checkpoint with this run's target identity.
  const reusedFinding = record("beta", "windows-x86-64", {
    sha256: sha("b"),
    signals: [{ ...signal, path: "z.bin" }, signal],
    signal_count: 2,
  });
  return bound({
    scanned: [flagged, record("alpha", "windows-x86-64")],
    reused: 2,
    reused_targets: [reusedTarget(reusedFinding), reusedTarget(record("gamma", "linux-x86-64"))],
    findings: [flagged, reusedFinding],
    unscanned: [
      unscanned("gamma", "windows-x86-64", "no-single-asset"),
      unscanned("delta", "linux-x86-64", "asset-too-large"),
      unscanned("epsilon", "windows-x86-64", "time-budget"),
      unscanned("zeta", "linux-x86-64", "no-release"),
      unscanned("zeta", "windows-x86-64", "scan-failed"),
    ],
  });
}

/** A reused target as the scan names it: its target and the package it reuses. */
function reusedTarget({ id, platform, key, tag, asset, sha256 }: ReturnType<typeof record>) {
  return { id, platform, key, tag, asset, sha256 };
}

/** A format-3 report whose declared targets are exactly its own entries, as the scan writes it. */
function bound<T extends { scanned: object[]; reused_targets: object[]; unscanned: object[] }>(
  lists: T,
) {
  const targets = [...lists.scanned, ...lists.reused_targets, ...lists.unscanned] as {
    id: string;
    platform: string;
  }[];
  return {
    ...lists,
    format_version: 3,
    targets: targets.length,
    targets_sha256: targetsDigest(targets),
  };
}

void test("release-content facts keep findings and persistent unscannable targets; deferred ports are gaps", () => {
  const { expected, facts, gaps } = releaseContentFacts(report());
  assert.equal(expected, 6);
  assert.deepEqual([...facts.keys()], ["port:alpha", "port:beta", "port:delta", "port:gamma"]);
  assert.deepEqual(facts.get("port:alpha"), {
    findings: [
      {
        platform: "linux-x86-64",
        repository: "up/alpha",
        tag: "v1",
        asset: "alpha-linux-x86-64.zip",
        sha256: sha("a"),
        rules: 2,
        signals: [signal],
        signal_count: 1,
      },
    ],
    unscannable: [],
  });
  // Reused findings are facts too; signals are ordered by path.
  assert.deepEqual(
    facts.get("port:beta")?.findings[0]?.signals.map(({ path }) => path),
    ["data/game.z64", "z.bin"],
  );
  assert.deepEqual(facts.get("port:gamma"), {
    findings: [],
    unscannable: [{ platform: "windows-x86-64", code: "no-single-asset" }],
  });
  assert.deepEqual(facts.get("port:delta")?.unscannable, [
    { platform: "linux-x86-64", code: "asset-too-large" },
  ]);
  // Run-specific fields never reach a fact, so a reused package stays quiet.
  assert.ok(!JSON.stringify([...facts.values()]).includes("heads_unread"));
  assert.ok(!JSON.stringify([...facts.values()]).includes("free text"));
  assert.deepEqual(
    gaps.map(({ subject_key, code, deferred }) => [subject_key, code, deferred]),
    [
      [
        "port:epsilon",
        "release-content-deferred",
        [{ platform: "windows-x86-64", code: "time-budget" }],
      ],
      [
        "port:zeta",
        "release-content-deferred",
        [{ platform: "windows-x86-64", code: "scan-failed" }],
      ],
    ],
  );
  assert.match(gaps[0]!.message, /windows-x86-64: time-budget/u);
});

void test("the same targets in another order and run are the same facts", () => {
  const first = releaseContentFacts(report());
  const shuffled = report();
  shuffled.scanned.reverse();
  shuffled.findings.reverse();
  shuffled.unscanned.reverse();
  shuffled.scanned[0] = { ...shuffled.scanned[0]!, entries: 99, heads_unread: 4 };
  const again = releaseContentFacts(shuffled);
  assert.deepEqual([...again.facts], [...first.facts]);
});

void test("a finding on a deferred port stays visible from its gap", () => {
  const value = report();
  value.unscanned.push(unscanned("alpha", "macos-arm64", "release-read-failed"));
  const { facts, gaps } = releaseContentFacts(bound(value));
  assert.equal(facts.has("port:alpha"), false);
  const gap = gaps.find(({ subject_key }) => subject_key === "port:alpha")!;
  assert.deepEqual(
    gap.findings.map(({ asset }) => asset),
    ["alpha-linux-x86-64.zip"],
  );
  assert.deepEqual(
    releaseContentFindings(null, gap).map(({ asset }) => asset),
    ["alpha-linux-x86-64.zip"],
  );
  // Stored and gap findings for the same package are shown once.
  assert.equal(releaseContentFindings({ findings: gap.findings }, gap).length, 1);
  assert.deepEqual(releaseContentAttention({ findings: gap.findings }, gap), [
    "release content: linux-x86-64 v1 alpha-linux-x86-64.zip (data/game.z64: Nintendo 64 ROM image)",
  ]);
  assert.deepEqual(releaseContentAttention(null, null), []);
});

void test("every persistent scan code is a stored unscannable target", () => {
  const value = report();
  value.unscanned.splice(
    0,
    value.unscanned.length,
    ...PERSISTENT_UNSCANNED.map((code, index) => unscanned("eta", `platform-${index}`, code)),
  );
  const { facts, gaps } = releaseContentFacts(bound(value));
  assert.deepEqual(
    facts.get("port:eta")?.unscannable.map(({ code }) => code),
    [...PERSISTENT_UNSCANNED],
  );
  assert.ok(!gaps.some(({ subject_key }) => subject_key === "port:eta"));
});

void test("every not-scannable target is shown; packages nobody inspected need attention", () => {
  const value = report();
  value.unscanned.push(
    unscanned("epsilon", "linux-x86-64", "encrypted-archive"),
    unscanned("delta", "windows-x86-64", "no-release"),
  );
  const { facts, gaps } = releaseContentFacts(bound(value));
  const delta = facts.get("port:delta");
  assert.deepEqual(releaseContentUnscannable(delta), [
    { platform: "linux-x86-64", code: "asset-too-large", attention: true },
    { platform: "windows-x86-64", code: "no-release", attention: false },
  ]);
  assert.deepEqual(releaseContentAttention(delta), [
    "release content not scannable: linux-x86-64 asset-too-large",
  ]);
  assert.deepEqual(releaseContentAttention(facts.get("port:gamma")), [], "a coverage note only");
  // A deferred port's persistent targets are visible from its gap.
  const epsilon = gaps.find(({ subject_key }) => subject_key === "port:epsilon")!;
  assert.deepEqual(releaseContentAttention(null, epsilon), [
    "release content not scannable: linux-x86-64 encrypted-archive",
  ]);
  assert.equal(releaseContentUnscannable(epsilon, epsilon).length, 1, "shown once");
});

void test("an unsupported or inconsistent report is refused", () => {
  const refused = (mutate: (value: ReturnType<typeof report>) => unknown) => {
    const value = report();
    const changed = mutate(value) ?? value;
    assert.throws(() => releaseContentFacts(changed), /Unsupported release-content report/u);
  };
  assert.throws(() => releaseContentFacts(null), /Unsupported release-content report/u);
  refused((value) => ({ ...value, format_version: 1 }));
  refused((value) => ({ ...value, format_version: 2 }));
  // The denominator is the scan's own target count: an empty or truncated report
  // can never pass as complete and erase stored facts.
  refused(() => bound({ scanned: [], reused: 0, reused_targets: [], findings: [], unscanned: [] }));
  refused((value) => {
    value.unscanned.pop();
  });
  refused((value) => ({ ...value, targets: value.targets + 1 }));
  refused((value) => {
    const { targets: _omitted, ...rest } = value;
    return rest;
  });
  refused((value) => {
    value.unscanned[4] = { ...value.unscanned[4]!, id: "eta" };
  });
  refused((value) => ({ ...value, targets_sha256: "0".repeat(64) }));
  // A report from before reused targets were named cannot account for every target.
  refused((value) => {
    const { reused_targets: _omitted, ...rest } = value;
    return rest;
  });
  refused((value) => ({ ...value, reused: 3 }));
  refused((value) => {
    value.unscanned[0] = { ...value.unscanned[0]!, code: "budget" };
  });
  refused((value) => {
    const { code: _omitted, ...rest } = value.unscanned[0]!;
    value.unscanned[0] = rest as (typeof value.unscanned)[number];
  });
  // Each target is exactly one of scanned, reused or not scanned.
  refused((value) => {
    value.unscanned.push(unscanned("alpha", "linux-x86-64", "time-budget"));
  });
  refused((value) => {
    value.findings.push(record("omega", "linux-x86-64", { signals: [signal] }));
  });
  refused((value) => {
    value.findings[0] = { ...value.findings[0]!, sha256: "not-a-digest" };
  });
  refused((value) => {
    value.findings[0] = { ...value.findings[0]!, signals: [] };
  });
  refused((value) => {
    value.scanned[0] = { ...value.scanned[0]!, id: "Not A Port" };
  });
});

void test("findings must match their scanned or reused package exactly", () => {
  const refused = (label: string, mutate: (value: ReturnType<typeof report>) => void) => {
    const value = report();
    mutate(value);
    assert.throws(
      () => releaseContentFacts(bound(value)),
      /Unsupported release-content report/u,
      label,
    );
  };
  refused("a scanned record with signals has no finding", (value) => {
    value.findings.shift();
  });
  refused("a clean scanned record has a finding", (value) => {
    value.findings.push({ ...value.scanned[1]!, signals: [signal], signal_count: 1 });
  });
  refused("a duplicate finding", (value) => {
    value.findings.push(value.findings[0]!);
  });
  for (const field of ["tag", "asset", "sha256", "key"] as const) {
    refused(`a scanned finding's ${field} differs`, (value) => {
      value.findings[0] = {
        ...value.findings[0]!,
        [field]: field === "sha256" ? sha("c") : "other",
      };
    });
    refused(`a reused finding's ${field} differs`, (value) => {
      value.findings[1] = {
        ...value.findings[1]!,
        [field]: field === "sha256" ? sha("c") : "other",
      };
    });
  }
  refused("a reused target lacks its package", (value) => {
    const { sha256: _omitted, ...rest } = value.reused_targets[0]!;
    value.reused_targets[0] = rest as (typeof value.reused_targets)[number];
  });
  refused("a signal count below the signals kept", (value) => {
    value.findings[0] = { ...value.findings[0]!, signal_count: 0 };
  });
  refused("more signals than the cap", (value) => {
    const many = Array.from({ length: SIGNAL_CAP + 1 }, (_, index) => ({
      ...signal,
      path: `${index}.z64`,
    }));
    value.scanned[0] = { ...value.scanned[0]!, signals: many, signal_count: many.length };
    value.findings[0] = { ...value.findings[0]!, signals: many, signal_count: many.length };
  });
  refused("a cut count without a full cap", (value) => {
    value.findings[0] = { ...value.findings[0]!, signal_count: 5 };
  });
  refused("an accounting without reviewed evidence", (value) => {
    value.findings[0] = {
      ...value.findings[0]!,
      accounted: { reason: "reviewed", evidence: "https://example.invalid/1" },
    } as (typeof value.findings)[number];
  });
});

void test("an accounted finding is stored with its review but is not attention", () => {
  const value = report();
  const accounted = {
    reason: "Synthetic homebrew test file",
    evidence: "https://github.com/boburning/portcove/pull/7",
  };
  value.findings[0] = { ...value.findings[0]!, accounted } as (typeof value.findings)[number];
  const { facts } = releaseContentFacts(bound(value));
  const alpha = facts.get("port:alpha")!;
  assert.deepEqual(alpha.findings[0]!.accounted, accounted);
  assert.deepEqual(releaseContentAttention(alpha), []);
  assert.equal(releaseContentFindings(alpha).length, 1, "still shown");
  // A finding without accounting stores no accounting field, so its fact is unchanged.
  assert.equal("accounted" in facts.get("port:beta")!.findings[0]!, false);
});

void test("signals cut by the scan's cap are counted in the inventory text", () => {
  const many = Array.from({ length: SIGNAL_CAP }, (_, index) => ({
    ...signal,
    path: `${String(index).padStart(2, "0")}.z64`,
  }));
  const value = report();
  value.scanned[0] = { ...value.scanned[0]!, signals: many, signal_count: SIGNAL_CAP + 3 };
  value.findings[0] = { ...value.findings[0]!, signals: many, signal_count: SIGNAL_CAP + 3 };
  const alpha = releaseContentFacts(bound(value)).facts.get("port:alpha")!;
  assert.equal(alpha.findings[0]!.signal_count, SIGNAL_CAP + 3);
  assert.match(signalSummary(alpha.findings[0]!), /; and 3 more$/u);
  assert.match(releaseContentAttention(alpha)[0]!, /and 3 more\)$/u);
});

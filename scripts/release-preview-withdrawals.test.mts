import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  applyReviewedPreviewWithdrawals,
  assertPreviewWithdrawalClassification,
  inspectPreviewWithdrawals,
  previewWithdrawalSourcePath,
  readPreviewWithdrawalSource,
} from "./release-preview-withdrawals.mts";
import { mergeReleaseRecordBytes, releaseRecordManifestBytes } from "./release-signing-context.mts";
import { validateOpportunity } from "./release-coordinator.mts";
import { inspectSemanticProposalResult } from "./release-semantic-proposal.mts";
import type { prepareFrozenSemanticProposalInputs } from "./release-semantic-inputs.mts";
import { isRecord } from "./runtime-values.mts";
import { inspectSemanticRuntimeEvents } from "./release-semantic-runtime.mts";
import { createSemanticSnapshotReader } from "./release-semantic-reader-core.mts";
import { capacityDigest } from "./release-capacity.mts";

const json = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const version = "0.1.0-beta.1";
  const releasePath = `releases/${version}/windows-x86_64/nsis.json`;
  const promotionPath = `channels/preview/windows-x86_64/nsis/${version}.json`;
  const release = json({
    schema_version: 1,
    version,
    target: "windows-x86_64",
    package: { kind: "nsis" },
    source_commit: "a".repeat(40),
    artifact: { sha256: "b".repeat(64) },
  });
  const promotion = json({
    schema_version: 1,
    channel: "preview",
    target: "windows-x86_64",
    package: "nsis",
    version,
    release_path: releasePath,
    release_sha256: hash(release),
    eligible: true,
    production_eligible: false,
    withdrawn: false,
    reason: null,
    required_bridge: null,
  });
  const request = {
    promotion_path: promotionPath,
    promotion_sha256: hash(promotion),
    release_path: releasePath,
    release_sha256: hash(release),
    reason: "Withdraw this Preview and offer the independently qualified forward repair.",
  };
  const source = json({
    schema_version: 1,
    withdrawals: [
      {
        ...request,
        prior_promotion_utf8: promotion.toString(),
        prior_release_utf8: release.toString(),
      },
    ],
  });
  const blob = createHash("sha1").update(`blob ${source.length}\0`).update(source).digest("hex");
  const bundle = {
    manifest: {
      snapshots: { source: [{ mode: "100644", path: previewWithdrawalSourcePath, oid: blob }] },
    },
    files: [{ name: `objects/${blob}.data`, bytes: source }],
  };
  const prior = new Map([
    [releasePath, release],
    [promotionPath, promotion],
  ]);
  const manifest = {
    schema_version: 1,
    records: [
      {
        kind: "release",
        path: releasePath,
        version,
        target: "windows-x86_64",
        package: "nsis",
        bytes: release.length,
        sha256: hash(release),
      },
      {
        kind: "promotion",
        channel: "preview",
        path: promotionPath,
        version,
        target: "windows-x86_64",
        package: "nsis",
        bytes: promotion.length,
        sha256: hash(promotion),
      },
    ],
  };
  const opportunity = {
    source_commit: "1".repeat(40),
    source_tree: "2".repeat(40),
    base_commit: "3".repeat(40),
    change_set_sha256: "4".repeat(64),
    complete_change_set: true,
    meaningful: true,
    documentation_only: false,
    urgency: false,
    requested_channel: "preview",
    classification: {
      source_commit: "1".repeat(40),
      reviewed_commit: "1".repeat(40),
      source_tree: "2".repeat(40),
      reviewed_tree: "2".repeat(40),
      change_set_sha256: "4".repeat(64),
      preview_withdrawals: [request],
    },
  };
  return {
    version,
    releasePath,
    promotionPath,
    release,
    promotion,
    request,
    source,
    bundle,
    prior,
    manifest,
    opportunity,
  };
}

void test("reviewed prior source bytes project to exact small classification and source identity", () => {
  const f = fixture();
  assert.deepEqual(readPreviewWithdrawalSource(f.bundle), [f.request]);
  assert.deepEqual(
    assertPreviewWithdrawalClassification(f.opportunity.classification, [f.request]),
    [f.request],
  );
  assert.deepEqual(validateOpportunity(f.opportunity).classification.preview_withdrawals, [
    f.request,
  ]);
  assert.throws(
    () => validateOpportunity({ ...f.opportunity, requested_channel: "stable" }),
    /Stable/,
  );
  assert.throws(() => assertPreviewWithdrawalClassification({}, [f.request]), /frozen source/);
  assert.throws(
    () =>
      assertPreviewWithdrawalClassification(
        { preview_withdrawals: [{ ...f.request, reason: "Changed after freeze" }] },
        [f.request],
      ),
    /frozen source/,
  );
  assert.throws(
    () =>
      readPreviewWithdrawalSource({
        ...f.bundle,
        files: [{ ...f.bundle.files[0]!, bytes: Buffer.from("{}") }],
      }),
    /source bytes/,
  );
  assert.throws(
    () =>
      readPreviewWithdrawalSource({
        ...f.bundle,
        manifest: {
          snapshots: { source: [{ ...f.bundle.manifest.snapshots.source[0]!, mode: "120000" }] },
        },
      }),
    /regular/,
  );
  assert.deepEqual(
    readPreviewWithdrawalSource({ manifest: { snapshots: { source: [] } }, files: [] }),
    [],
  );
});

void test("only exact eligible Preview record changes; immutable release and Stable bytes survive forward repair merge", () => {
  const f = fixture(),
    stable = Buffer.from("retained Stable bytes\n");
  f.prior.set("channels/stable/windows-x86_64/nsis/1.0.0.json", stable);
  f.manifest.records.push({
    kind: "promotion",
    channel: "stable",
    path: "channels/stable/windows-x86_64/nsis/1.0.0.json",
    version: "1.0.0",
    target: "windows-x86_64",
    package: "nsis",
    bytes: stable.length,
    sha256: hash(stable),
  });
  const changed = applyReviewedPreviewWithdrawals(
    f.prior,
    f.manifest,
    f.opportunity.classification,
    "0.1.0-beta.2",
  );
  assert.deepEqual(changed.files.get(f.releasePath), f.release);
  assert.deepEqual(changed.files.get("channels/stable/windows-x86_64/nsis/1.0.0.json"), stable);
  assert.deepEqual(JSON.parse(changed.files.get(f.promotionPath)!.toString()), {
    ...JSON.parse(f.promotion.toString()),
    eligible: false,
    withdrawn: true,
    reason: f.request.reason,
  });
  assert.deepEqual(f.prior.get(f.promotionPath), f.promotion);
  assert.throws(() => mergeReleaseRecordBytes(f.prior, changed.files), /immutable/);
  const forward = "releases/0.1.0-beta.2/windows-x86_64/nsis.json",
    forwardBytes = Buffer.from("new independently reconstructed release\n");
  const merged = mergeReleaseRecordBytes(changed.files, new Map([[forward, forwardBytes]]));
  const forwardManifest = {
    schema_version: 1,
    records: [
      {
        ...f.manifest.records[0],
        path: forward,
        version: "0.1.0-beta.2",
        bytes: forwardBytes.length,
        sha256: hash(forwardBytes),
      },
    ],
  };
  const combined: unknown = JSON.parse(
    releaseRecordManifestBytes([changed.manifest, forwardManifest], merged).toString(),
  );
  assert.ok(isRecord(combined) && Array.isArray(combined.records));
  assert.equal(combined.records.length, 4);
  assert.throws(
    () => releaseRecordManifestBytes([f.manifest, forwardManifest], merged),
    /byte identity/,
  );
  const unchanged = applyReviewedPreviewWithdrawals(f.prior, f.manifest, {}, "0.1.0-beta.2");
  assert.deepEqual([...unchanged.files], [...f.prior]);
  assert.deepEqual(unchanged.manifest, f.manifest);
});

void test("wrong authenticated prior, reactivation, duplicate targets and malformed bounded request refuse", () => {
  const f = fixture();
  for (const request of [
    { ...f.request, promotion_sha256: "0".repeat(64) },
    { ...f.request, release_sha256: "0".repeat(64) },
    { ...f.request, promotion_path: f.promotionPath.replace("preview", "stable") },
    { ...f.request, release_path: f.releasePath.replace("beta.1", "beta.2") },
    { ...f.request, reason: "x".repeat(1025) },
    { ...f.request, reason: " " },
    { ...f.request, eligible: true },
  ])
    assert.throws(() =>
      applyReviewedPreviewWithdrawals(
        f.prior,
        f.manifest,
        { preview_withdrawals: [request] },
        "0.1.0-beta.2",
      ),
    );
  assert.throws(() => inspectPreviewWithdrawals([f.request, f.request]), /uniqueness/);
  assert.throws(() => inspectPreviewWithdrawals(Array(17).fill(f.request)), /count/);
  assert.throws(
    () =>
      applyReviewedPreviewWithdrawals(
        new Map(),
        f.manifest,
        f.opportunity.classification,
        "0.1.0-beta.2",
      ),
    /missing/,
  );
  assert.throws(
    () =>
      applyReviewedPreviewWithdrawals(
        f.prior,
        { ...f.manifest, records: [] },
        f.opportunity.classification,
        "0.1.0-beta.2",
      ),
    /manifest row/,
  );
  assert.throws(
    () =>
      applyReviewedPreviewWithdrawals(f.prior, f.manifest, f.opportunity.classification, f.version),
    /later/,
  );
  const changed = applyReviewedPreviewWithdrawals(
    f.prior,
    f.manifest,
    f.opportunity.classification,
    "0.1.0-beta.2",
  );
  assert.throws(
    () =>
      applyReviewedPreviewWithdrawals(
        changed.files,
        changed.manifest,
        f.opportunity.classification,
        "0.1.0-beta.2",
      ),
    /bytes differ/,
  );
});

void test("untrusted proposal carries source request into separately reviewed complete opportunity without new review schema", () => {
  const f = fixture();
  const bundle = {
    ...f.bundle,
    bundle_sha256: "5".repeat(64),
    manifest: {
      ...f.bundle.manifest,
      opportunity: {
        ...f.opportunity,
        request_id: "6".repeat(64),
        base_version: f.version,
        change_set_scope: "net-tree-delta-v1",
      },
    },
  } as unknown as ReturnType<typeof prepareFrozenSemanticProposalInputs>;
  const result = inspectSemanticProposalResult(
    {
      schema_version: 1,
      outcome: "proposed",
      request_id: "6".repeat(64),
      bundle_sha256: bundle.bundle_sha256,
      coverage: { accumulated_changes: true, classification: true, compatibility: true },
      proposal: {
        change: "prerelease",
        compatibility: "compatible",
        migration_notes: null,
        prerelease_identifier: null,
        meaningful: true,
        documentation_only: false,
        urgency: false,
      },
      report: "Inert shape fixture; no acceptance.",
    },
    bundle,
  );
  assert.deepEqual(result.opportunity?.classification.preview_withdrawals, [f.request]);
});

void test("whole-opportunity acceptance requires complete withdrawal evidence even when its source file is unchanged", () => {
  const f = fixture();
  const manifest = {
    ...f.bundle.manifest,
    opportunity: f.opportunity,
    opportunity_sha256: capacityDigest(f.opportunity),
    baseline: {},
    source: { changes: [] },
    evidence: {},
    snapshots: { ...f.bundle.manifest.snapshots, baseline: f.bundle.manifest.snapshots.source },
  };
  const bundle = {
    ...f.bundle,
    files: f.bundle.files.map((file) => ({ ...file, sha256: hash(file.bytes) })),
    manifest,
    bundle_sha256: capacityDigest(manifest),
  } as unknown as Parameters<typeof inspectSemanticRuntimeEvents>[1];
  const reader = createSemanticSnapshotReader(bundle);
  const reads = (snapshot: string, name: string, length: number) => {
    const args = { snapshot, path: name, offset: 0, length },
      call = {
        id: `${snapshot}:${name}:${length}`,
        type: "mcp_tool_call",
        server: "portcove_frozen_bundle",
        tool: "read",
        arguments: args,
      };
    return [
      { type: "item.started", item: { ...call, status: "in_progress" } },
      {
        type: "item.completed",
        item: {
          ...call,
          status: "completed",
          error: null,
          result: { content: [{ type: "text", text: JSON.stringify(reader("read", args)) }] },
        },
      },
    ];
  };
  const metadata = reads("manifest", "manifest.json", Buffer.byteLength(JSON.stringify(manifest)));
  const events = (extra: unknown[]) =>
    Buffer.from(
      [
        { type: "thread.started", thread_id: "01234567-0123-0123-0123-0123456789ab" },
        { type: "turn.started" },
        ...metadata,
        ...extra,
        {
          type: "item.completed",
          item: {
            type: "agent_message",
            text: JSON.stringify({
              schema_version: 1,
              outcome: "accepted",
              opportunity_sha256: manifest.opportunity_sha256,
              bundle_sha256: bundle.bundle_sha256,
              coverage: { accumulated_changes: true, classification: true, compatibility: true },
              report: "Inert observation fixture; no actual independent judgment.",
            }),
          },
        },
        { type: "turn.completed" },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n"),
    );
  assert.throws(
    () => inspectSemanticRuntimeEvents(events([]), bundle),
    /lacks relevant.*release-preview-withdrawals/u,
  );
  assert.throws(
    () =>
      inspectSemanticRuntimeEvents(
        events(reads("source", previewWithdrawalSourcePath, 32)),
        bundle,
      ),
    /lacks relevant/u,
  );
  assert.equal(
    inspectSemanticRuntimeEvents(
      events(reads("source", previewWithdrawalSourcePath, f.source.length)),
      bundle,
    ).result.outcome,
    "accepted",
  );
});

// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceInspectionReport } from "../types";
import { focusableControls } from "../focus";
import { SourceIdentityPanel } from "./SourceIdentity";

const calculatedSha = "a".repeat(64);
const expectedSha = "b".repeat(64);

function report(stateCode = "recognized_exact"): SourceInspectionReport {
  const classification = stateCode === "ambiguous_identity"
    ? { state: "ambiguous" as const, candidates: [{ game_id: "game", variant_id: "edition", representation_id: "raw" }, { game_id: "game", variant_id: "other", representation_id: "raw" }] }
    : stateCode === "accepted_identity_unknown" || stateCode === "known_mismatch"
      ? { state: "unrecognized" as const }
      : { state: "recognized" as const, identity: { game_id: "game", variant_id: "edition", representation_id: "raw" } };
  const admission = stateCode === "known_mismatch"
    ? { state: "rejected" as const, reason: "known_mismatch" as const }
    : stateCode === "accepted_identity_unknown"
      ? { state: "admitted" as const, mode: "informational_consent" as const }
      : { state: "admitted" as const, mode: "exact_identity" as const };
  return {
    schema_version: 1,
    profile_id: "game",
    health: stateCode === "source_missing" ? "missing" : stateCode === "source_changed" ? "changed" : "current",
    state_code: stateCode,
    summary: stateCode === "known_mismatch" ? "This file is a known mismatch." : "The selected source was checked locally.",
    next_action: "Review this result before setup.",
    registered: { profile_id: "game", path: "D:/Games/selected.zip", sha256: calculatedSha, size: 4096, storage_sha256: "c".repeat(64), storage_size: 8192, updated_at: 1 },
    inspection: stateCode === "source_missing" ? undefined : {
      profile_id: "game", path: "D:/Games/selected.zip",
      observed_digests: [
        { algorithm: "sha256", scope: "original-container", value: "c".repeat(64), size: 8192 },
        { algorithm: "sha256", scope: "normalized-content", value: calculatedSha, size: 4096 },
      ],
      archive_member_name: "game.z64",
      components: [
        { id: "program", kind: "file_set_member", name: "program.bin", digests: [{ algorithm: "sha256", scope: "file-set-member", value: "d".repeat(64), size: 1024 }], size: 1024, track_count: null, volume_id: null },
        { id: "disc-1", kind: "optical_disc", name: "Disc 1", digests: [{ algorithm: "sha1", scope: "disc-set-member", value: "e".repeat(40), size: 2048 }], size: 2048, track_count: 12, volume_id: "GAME_DISC_1" },
      ],
      assessment: { health: "current", classification, contract: { state: "supported", contract_id: "game-port" }, admission, evidence: [] },
      message: "Checked locally",
    },
    problem: stateCode === "source_missing" ? { code: "not_found", message: "The registered file is missing." } : undefined,
    expected_identity: {
      id: "game", label: "Sample Game File", kind: "compound", aliases: [], tombstones: [], evidence_gap: null,
      variants: [{ id: "edition", title: "Reviewed Edition", region: "USA", revision: "1.0", product_codes: ["GAME-01"], evidence_ids: ["identity-proof"], representations: [
        { id: "raw", kind: "compound", format: "stfs-live", extensions: ["zip"], evidence_ids: ["identity-proof"], identities: [{ scope: "normalized-content", sha1: null, sha256: expectedSha, crc32: null }] },
        { id: "members", kind: "file-set", extensions: [], evidence_ids: [], members: [{ id: "program", label: "Program", filenames: ["program.bin"], identities: [{ scope: "file-set-member", sha1: null, sha256: "d".repeat(64), crc32: null }] }] },
      ] }],
    },
    applications: [{
      port_id: "sample", port_name: "Sample Port", role: "game",
      contract: { id: "game-port", port_id: "sample", role: "game", profile_id: "game", admission_mode: "enforced", supported_variant_ids: ["edition"], validator_contract_id: null, evidence_ids: ["identity-proof"], authority_ref: "Sample upstream requirement", reviewed_at: "2026-09-06", immutable_review_url: "https://example.com/review/commit", live_review_url: null, evidence_gap: null, applicability: [{ upstream_ref: "v1", artifact_sha256: "f".repeat(64) }], aliases: [], tombstones: [] },
      contract_result: stateCode === "recognized_not_listed" ? { state: "recognized_not_listed", contract_id: "game-port" } : stateCode === "known_mismatch" ? { state: "known_incompatible", contract_id: "game-port" } : stateCode === "release_inapplicable" ? { state: "unreviewed_for_release" } : { state: "supported", contract_id: "game-port" },
      release_applicability: { state_code: stateCode === "release_inapplicable" ? "not_rebound" : "artifact_bound", reviewed_bindings: [{ upstream_ref: "v1", artifact_sha256: "f".repeat(64) }] },
      qualification: { legacy_automated_platforms: ["windows-x86-64"], legacy_hands_on_platforms: [], exact_records: [{ scope: { port_id: "sample", platform: "linux-x86-64", artifact_sha256: "f".repeat(64), upstream_ref: "v1", contract_id: "game-port", variant: { state: "exact", identity: { game_id: "game", variant_id: "edition", representation_id: "raw" } }, check_version: "1" }, kind: "automated_lifecycle", outcome: "passed", observed_at: 1, portcove_version: "0.1.0-alpha.2", portcove_commit: "1".repeat(40), method: "fixture", evidence_ids: [] }] },
    }],
    evidence: [{ id: "identity-proof", role: "byte_identity", authority: "Sample authority", authority_ref: "catalog row", reviewed_at: "2026-09-06", claim: "Expected source identity", immutable_url: "https://example.com/review/commit" }],
    legacy: { registration_identity_not_recorded: false, variant_unspecified_records: [] },
  };
}

describe("source identity presentation", () => {
  it.each([
    ["recognized_exact", "Exact match"],
    ["accepted_identity_unknown", "Accepted · identity unknown"],
    ["ambiguous_identity", "Couldn't determine one edition"],
    ["selected_needs_checking", "Selected · needs checking"],
    ["not_evaluated", "Not evaluated"],
    ["known_mismatch", "Known mismatch · refused"],
    ["source_changed", "Doesn't match registered source"],
    ["source_missing", "Couldn't check · file missing"],
    ["recognized_not_listed", "Recognized · not listed"],
    ["release_inapplicable", "Not applicable to this release"],
  ])("renders %s without collapsing its meaning", (state, expected) => {
    const html = renderToStaticMarkup(<SourceIdentityPanel report={report(state)} />).replaceAll("&#x27;", "'");
    expect(html).toContain(expected);
    expect(html).toContain("Source result:");
  });

  it("labels a legacy row without structured observations as not evaluated", () => {
    const legacy = report("not_evaluated");
    legacy.inspection = undefined;
    legacy.legacy.registration_identity_not_recorded = true;
    const html = renderToStaticMarkup(<SourceIdentityPanel report={legacy} />);
    expect(html).toContain("Legacy registration · not evaluated");
    expect(html).not.toContain("Exact match");
  });

  it("shows full scoped hashes, compound members, missing expectations, evidence classes, and the non-mutation boundary", () => {
    const html = renderToStaticMarkup(<SourceIdentityPanel report={report()} openEvidence={vi.fn()} />);
    for (const text of [calculatedSha, expectedSha, "original container", "normalized content", "program.bin", "12 tracks", "GAME_DISC_1", "Exact member match", "Expected identity missing", "Missing from reviewed evidence", "Exact automated evidence", "Exact hands-on evidence", "Legacy port-wide automated", "Missing gameplay evidence does not block", "did not modify, normalize, move, or upload"]) expect(html).toContain(text);
    expect(html).toContain("Copy Calculated SHA256 for normalized content");
    expect(html).toContain("Open reviewed evidence from Sample authority");
  });
});

describe("source identity controls", () => {
  let root: Root;
  let host: HTMLDivElement;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([new DOMRect(0, 0, 100, 40)] as unknown as DOMRectList);
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("keeps copy and evidence controls named, keyboard reachable, and focused across a current report refresh", async () => {
    const open = vi.fn();
    await act(async () => root.render(<SourceIdentityPanel report={report()} openEvidence={open} />));
    const details = host.querySelector("details")!; details.open = true;
    const copy = host.querySelector<HTMLButtonElement>("[aria-label='Copy Calculated SHA256 for normalized content']")!;
    const evidence = host.querySelector<HTMLButtonElement>("[aria-label='Open reviewed evidence from Sample authority']")!;
    expect(copy.tabIndex).toBe(0); expect(evidence.tabIndex).toBe(0); expect(host.querySelector("summary")?.hasAttribute("data-focusable")).toBe(true);
    copy.focus();
    await act(async () => root.render(<SourceIdentityPanel report={report()} openEvidence={open} />));
    expect(document.activeElement).toBe(copy);
    await act(async () => evidence.click());
    expect(open).toHaveBeenCalledWith("identity-proof");
  });

  it("puts disclosure, copy, and evidence actions in the shared keyboard and controller inventory", async () => {
    await act(async () => root.render(<SourceIdentityPanel report={report()} openEvidence={vi.fn()} />));
    host.querySelector("details")!.open = true;
    const names = focusableControls(host).map(control => control.getAttribute("aria-label") ?? control.textContent);
    expect(names).toContain("Full identity and evidence");
    expect(names).toContain("Copy Calculated SHA256 for normalized content");
    expect(names).toContain("Open reviewed evidence from Sample authority");
  });
});

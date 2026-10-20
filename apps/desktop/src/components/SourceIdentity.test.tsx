import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { SourceIdentityPanel } from "./SourceIdentity";
import { fixtureValue } from "../test-fixtures";
import type { SourceInspectionReport } from "../types";
import {
  sourceInspectionIdentityFixture as report,
  sourceIdentityCalculatedSha as calculatedSha,
  sourceIdentityExpectedSha as expectedSha,
} from "../test-fixtures";
describe("source identity presentation", () => {
  it.each(["future_check_result", "constructor", "__proto__", "toString"])(
    "renders unknown result %s without claiming a match",
    (state) => {
      const value = report(state);
      value.applications[0].contract_result.state =
        state as SourceInspectionReport["applications"][number]["contract_result"]["state"];
      value.applications[0].release_applicability.state_code = state;
      const admission = value.inspection?.assessment.admission;
      if (admission?.state === "admitted") admission.mode = state as typeof admission.mode;
      const html = renderToStaticMarkup(<SourceIdentityPanel report={value} />);
      for (const label of [
        "Result unavailable",
        "Admission result unavailable",
        "Requirement result unavailable",
        "Release applicability unavailable",
      ])
        expect(html).toContain(label);
      expect(html).not.toContain("Game-file check result: Exact match");
    },
  );

  it("does not treat unknown digest algorithms as a match or call inherited properties", () => {
    const value = report();
    for (const component of value.inspection!.components) {
      for (const digest of component.digests)
        digest.algorithm = "constructor" as typeof digest.algorithm;
    }
    const html = renderToStaticMarkup(<SourceIdentityPanel report={value} />);
    expect(html).not.toContain("Exact member match");
    expect(html).toContain("Observed member evidence");
    expect(html).toContain("CONSTRUCTOR"); // The raw algorithm remains only in technical evidence.
  });

  it("names BIOS checks without calling them game-file checks", () => {
    const value = report();
    value.applications[0].role = "bios";
    const html = renderToStaticMarkup(<SourceIdentityPanel report={value} />);
    expect(html).toContain("BIOS check result: Exact match");
    expect(html).not.toContain("Game-file check result:");
  });

  it.each([
    ["check_failed", "File checks failed"],
    ["recognized_exact", "Exact match"],
    ["accepted_identity_unknown", "Edition unknown · review check details"],
    ["ambiguous_identity", "More checks needed · edition unclear"],
    ["selected_needs_checking", "More checks needed"],
    ["not_evaluated", "Not evaluated"],
    ["known_mismatch", "Files don't match reviewed requirements"],
    ["source_changed", "Files changed since they were added"],
    ["source_missing", "Files not found"],
    ["source_could_not_be_checked", "Files couldn't be checked"],
  ])("renders %s without collapsing its meaning", (state, expected) => {
    const html = renderToStaticMarkup(<SourceIdentityPanel report={report(state)} />).replaceAll(
      "&#x27;",
      "'",
    );
    expect(html).toContain(`Game-file check result: ${expected}`);
    expect(html).not.toContain("Source check complete:");
  });

  it.each([
    ["recognized_not_listed", "Recognized · not listed"],
    ["release_inapplicable", "Not reviewed for this release"],
  ])("keeps %s as an application result without claiming a global match", (state, expected) => {
    const html = renderToStaticMarkup(<SourceIdentityPanel report={report(state)} />);
    expect(html).toContain(expected);
    expect(html).toContain("Game-file check result: Result unavailable");
    expect(html).not.toContain("Not applicable to this release");
  });

  it.each([
    ["supported", "Matches evaluated source requirements"],
    ["unreviewed_for_release", "Not reviewed for this release"],
    ["not_evaluated", "Not evaluated"],
    ["recognized_not_listed", "Recognized · not listed"],
    ["known_incompatible", "Known mismatch · refused"],
  ] as const)("scopes the %s application result to source requirements", (state, expected) => {
    const value = report(state === "known_incompatible" ? "known_mismatch" : "recognized_exact");
    value.applications[0].contract_result =
      state === "unreviewed_for_release" || state === "not_evaluated"
        ? { state }
        : { state, contract_id: "game-port" };
    const html = renderToStaticMarkup(<SourceIdentityPanel report={value} />);
    expect(html).toContain(`>${expected}</span>`);
    expect(html).not.toContain(">Supported</span>");
    expect(html).not.toContain("Not applicable to this release");
    expect(html.includes("File not accepted · file does not match the required edition")).toBe(
      state === "known_incompatible",
    );
  });

  it("distinguishes structural checks from consent when an edition is unknown", () => {
    const structural = report("accepted_identity_unknown");
    const admission = structural.inspection?.assessment.admission;
    if (admission?.state !== "admitted") throw new Error("expected admitted fixture");
    admission.mode = "structural_checks";
    const html = renderToStaticMarkup(<SourceIdentityPanel report={structural} />);
    expect(html).toContain("Basic file checks passed · compatibility unconfirmed");
    expect(html).not.toContain("Exact match");
  });

  it("leads with result and next action while keeping authority and test counts in disclosures", () => {
    const html = renderToStaticMarkup(<SourceIdentityPanel report={report()} />);
    const firstDisclosure = html.indexOf('<details class="source-technical ');
    expect(firstDisclosure).toBeGreaterThan(-1);
    const primary = html.slice(0, firstDisclosure);
    expect(primary).toContain("Game-file check");
    expect(primary).toContain("Exact match");
    expect(primary).toContain("Next:");
    expect(primary).not.toContain("Admission");
    expect(primary).not.toContain("Recorded automated results");
    expect(primary).not.toContain("catalog row");
    expect(html.slice(firstDisclosure)).toContain("Admission");
    expect(html.slice(firstDisclosure)).toContain("File details and test results");
    expect(html.slice(firstDisclosure)).toContain("Recorded automated results");
  });

  it("keeps failed, unrun, and other-edition evidence distinct from a passed test", () => {
    const value = report();
    const automated = fixtureValue(
      value.applications[0].qualification.exact_records[0],
      "automated qualification",
    );
    automated.outcome = "failed";
    const unrun = structuredClone(automated);
    unrun.outcome = "not_run";
    unrun.kind = "hands_on";
    const otherEdition = structuredClone(unrun);
    otherEdition.outcome = "passed";
    if (otherEdition.scope.variant.state === "exact")
      otherEdition.scope.variant.identity.variant_id = "other";
    const otherFormat = structuredClone(unrun);
    otherFormat.outcome = "passed";
    if (otherFormat.scope.variant.state === "exact")
      otherFormat.scope.variant.identity.representation_id = "other-format";
    value.applications[0].qualification.exact_records.push(unrun, otherEdition, otherFormat);

    const html = renderToStaticMarkup(<SourceIdentityPanel report={value} />);
    expect(html).toContain("Failed · Linux · Edition edition, format raw");
    expect(html).toContain("Not run · Linux · Edition edition, format raw");
    expect(html).toContain("Passed · Linux · Edition other, format raw");
    expect(html).toContain("Passed · Linux · Edition edition, format other-format");
    expect(html).toContain("Hands-on results for this edition and file format: Not run.");
    expect(html).not.toContain("Hands-on results for this edition and file format: Passed");
    expect(html).toContain("Release v1");
    expect(html).toContain("Check version 1");
    expect(html).toContain(`Release artifact SHA-256 <code>${"f".repeat(64)}</code>`);
  });

  it("labels a legacy row without structured observations as not evaluated", () => {
    const legacy = report("not_evaluated");
    delete legacy.inspection;
    legacy.legacy.registration_identity_not_recorded = true;
    const html = renderToStaticMarkup(<SourceIdentityPanel report={legacy} />);
    expect(html).toContain("Legacy registration · not evaluated");
    expect(html).not.toContain("Exact match");
  });

  it("explains a known file rejection and keeps an unknown reason noncommittal", () => {
    const known = report("known_mismatch");
    expect(renderToStaticMarkup(<SourceIdentityPanel report={known} />)).toContain(
      "File not accepted · file does not match the required edition",
    );
    const unknown = report("known_mismatch");
    const admission = unknown.inspection?.assessment.admission;
    if (admission?.state === "rejected") admission.reason = "future_reason" as never;
    const html = renderToStaticMarkup(<SourceIdentityPanel report={unknown} />);
    expect(html).toContain("File not accepted · see file details");
    expect(html).not.toContain("future_reason");
  });

  it("shows full scoped hashes, compound members, missing expectations, evidence classes, and the non-mutation boundary", () => {
    const html = renderToStaticMarkup(
      <SourceIdentityPanel report={report()} openEvidence={vi.fn()} />,
    );
    for (const text of [
      calculatedSha,
      expectedSha,
      "original container",
      "normalized content",
      "program.bin",
      "12 tracks",
      "GAME_DISC_1",
      "Observed member evidence",
      "Missing from reviewed evidence",
      "Recorded automated results",
      "Recorded hands-on results",
      "Legacy port-wide automated",
      "No hands-on test is recorded for this edition and file format",
      "did not modify, normalize, move, or upload",
    ])
      expect(html).toContain(text);
    expect(html).toContain("Copy Calculated SHA256 for normalized content");
    expect(html).toContain("Open reviewed evidence from Sample authority");
  });
});

it("keeps partial multi-disc digests neutral while retaining Core's overall result", () => {
  const value = report("ambiguous_identity");
  const component = fixtureValue(value.inspection?.components[0], "first observed component");
  component.id = "disc-1";
  component.kind = "optical_disc";
  component.digests = [
    { algorithm: "sha1", scope: "disc-set-member", value: "a".repeat(40), size: 2048 },
  ];
  const identity = fixtureValue(value.expected_identity, "expected identity");
  identity.kind = "multi-disc-set";
  const variant = fixtureValue(identity.variants[0], "first variant");
  variant.representations = [
    {
      id: "discs",
      kind: "multi-disc-set",
      extensions: [],
      evidence_ids: [],
      discs: [
        {
          id: "disc-1",
          label: "Disc one",
          track_counts: [1],
          volume_ids: [],
          identities: [
            { scope: "disc-set-member", sha1: "a".repeat(40), sha256: null, crc32: "12345678" },
          ],
        },
        {
          id: "disc-2",
          label: "Disc two",
          track_counts: [1],
          volume_ids: [],
          identities: [
            { scope: "disc-set-member", sha1: "b".repeat(40), sha256: null, crc32: "87654321" },
          ],
        },
      ],
    },
  ];
  const html = renderToStaticMarkup(<SourceIdentityPanel report={value} />);
  expect(html).toContain("Calculated SHA1");
  expect(html).toContain("Expected CRC32");
  expect(html).toContain("12345678");
  expect(html).toContain("Observed member evidence");
  expect(html).toContain("More checks needed · edition unclear");
  expect(html).not.toContain("Exact member match");
  expect(html).not.toContain("Member doesn&#x27;t match");
});

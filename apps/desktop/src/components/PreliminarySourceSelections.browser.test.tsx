import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import type { SourceInspectionReport, SourceProfile } from "../types";
import {
  PreliminarySourceSelections,
  preliminarySelectionRecord,
} from "./PreliminarySourceSelections";

type Inspection = NonNullable<SourceInspectionReport["inspection"]>;
const profile: SourceProfile = {
  id: "disc",
  label: "Disc files",
  kind: "upstream-validated-disc",
  accepted_extensions: ["iso"],
  accepted_sha1: [],
  accepted_sha256: [],
  disc: null,
  members: [],
};
const selection: Inspection = {
  profile_id: profile.id,
  path: "D:/Selected/game.iso",
  observed_digests: [],
  components: [],
  validator: {
    contract_id: "disc-v1",
    tool_id: "validator",
    protocol_version: "1",
    result: "not_run",
  },
  assessment: {
    health: "not_baselined",
    classification: { state: "not_evaluated" },
    contract: { state: "not_evaluated" },
    admission: { state: "admitted", mode: "structural_checks" },
    evidence: [],
  },
  record: {
    profile_id: profile.id,
    path: "D:/Selected/game.iso",
    sha256: "a".repeat(64),
    storage_sha256: "a".repeat(64),
    size: 32,
    storage_size: 32,
    updated_at: 1,
  },
  message: "Preliminary selection; validation has not run",
};

it("refuses inconsistent identity, executed or unknown validator results and non-preliminary admission", () => {
  expect(preliminarySelectionRecord(selection)).toBe(selection.record);
  for (const invalid of [
    { ...selection, record: null },
    { ...selection, path: "D:/Other/game.iso" },
    { ...selection, profile_id: "other" },
    { ...selection, validator: null },
    { ...selection, validator: { ...selection.validator!, result: "future_result" } },
    { ...selection, validator: { ...selection.validator!, result: "passed" } },
    {
      ...selection,
      assessment: {
        ...selection.assessment,
        admission: { state: "admitted", mode: "exact_identity" },
      },
    },
    {
      ...selection,
      assessment: { ...selection.assessment, classification: { state: "unrecognized" } },
    },
  ])
    expect(preliminarySelectionRecord(invalid as Inspection)).toBeUndefined();
});

it("keeps legacy omission empty and stale selections disabled, then asks for deliberate location review", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const review = vi.fn();
  try {
    await act(async () =>
      root.render(
        <PreliminarySourceSelections profiles={[profile]} disabled={false} onReview={review} />,
      ),
    );
    expect(host.textContent).toBe("");
    await act(async () =>
      root.render(
        <PreliminarySourceSelections
          selections={[selection]}
          profiles={[profile]}
          disabled
          onReview={review}
        />,
      ),
    );
    expect(host.textContent).toContain("Validation has not run");
    expect(host.textContent).toContain("not exact matches");
    const button = host.querySelector("button")!;
    expect(button.disabled).toBe(true);
    await act(async () => button.click());
    expect(review).not.toHaveBeenCalled();
    await act(async () =>
      root.render(
        <PreliminarySourceSelections
          selections={[selection]}
          profiles={[profile]}
          disabled={false}
          onReview={review}
        />,
      ),
    );
    await act(async () => host.querySelector("button")!.click());
    expect(review).toHaveBeenCalledOnce();
    expect(review).toHaveBeenCalledWith(selection.record);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

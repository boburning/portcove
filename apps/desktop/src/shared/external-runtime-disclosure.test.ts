import { describe, expect, it } from "vite-plus/test";
import type { ExternalRuntimePreview } from "../types";
import { sharedRuntimeDisclosure } from "./external-runtime-disclosure";

type SharedReview = NonNullable<ExternalRuntimePreview["shared_preferences"]>;
const review: SharedReview = {
  binding: {
    contract: "smb1r-1.1-stable-windows",
    account_sid_sha256: "a".repeat(64),
    path: "C:\\Roaming\\SMB1R",
  },
  present: false,
  local_fallback_path: null,
  local_fallback_present: false,
};

describe("shared runtime consent disclosure", () => {
  it("explains the shared directory and destructive cache/log behavior without inventing a fallback", () => {
    const text = sharedRuntimeDisclosure(review);
    expect(text).toContain("C:\\Roaming\\SMB1R");
    expect(text).toContain("saves");
    expect(text).toContain("trash generated caches");
    expect(text).toContain("prune its logs");
    expect(text).not.toContain("instead");
  });
  it("refuses unknown and contradictory scope values before consent", () => {
    for (const changed of [
      { ...review, local_fallback_path: "C:\\unexpected" },
      { ...review, local_fallback_present: true },
      { ...review, binding: { ...review.binding, contract: "unknown" } },
      { ...review, binding: { ...review.binding, contract: "regaiden041-windows" } },
    ])
      expect(() => sharedRuntimeDisclosure(changed as SharedReview)).toThrow(
        "Unsupported or inconsistent shared write scope review.",
      );
  });
  it("preserves ReGaiden's real local fallback disclosure", () => {
    expect(
      sharedRuntimeDisclosure({
        ...review,
        binding: { ...review.binding, contract: "regaiden041-windows" },
        local_fallback_path: "H:\\Game\\runtime_prefs.ini",
      }),
    ).toContain("instead rewrite H:\\Game\\runtime_prefs.ini");
  });
});

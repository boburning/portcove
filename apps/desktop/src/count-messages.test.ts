import { afterEach, describe, expect, it } from "vite-plus/test";
import { countMessage, initializeLocalization } from "./localization";
import { sourceDiscoveryResultSummary } from "./components/SourceDiscovery";
import { progressPresentation } from "./view-model";

const instance = initializeLocalization();
afterEach(async () => {
  await instance.changeLanguage("en");
});

describe("localized application count messages", () => {
  it.each([
    [0, "Move completed. No recorded versions needed relocation."],
    [1, "Moved 1 recorded version and verified the new location."],
    [2, "Moved 2 recorded versions and verified the new location."],
    [1_000_000, "Moved 1,000,000 recorded versions and verified the new location."],
  ] as const)("formats %s using complete offline messages", (count, expected) => {
    expect(countMessage(count, "movedVersions")).toBe(expected);
  });
  it.each([
    undefined,
    null,
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])("keeps unavailable count %s distinct from zero", (count) => {
    expect(countMessage(count, "movedVersions")).toBe(
      "Move completed. The number of relocated versions is unavailable.",
    );
    expect(countMessage(count, "recoveryItems")).toBe("Recovery information is unavailable.");
  });
  it("uses bundled fallback resources without a backend or network", async () => {
    await instance.changeLanguage("ar-XB");
    expect(instance.hasResourceBundle("en", "counts")).toBe(true);
    expect(instance.options.backend).toBeUndefined();
    // English remains the supported message language outside the engineering panel.
    expect(countMessage(2, "updates")).toContain("updates available");
    expect(countMessage(undefined, "updates")).toBe("Update count unavailable");
  });
  it("formats numbers using i18next's active locale", () => {
    const translated = instance.t("movedVersions", {
      ns: "counts",
      count: 1000,
      lng: "en",
      formatParams: { count: { locale: "de" } },
    });
    expect(translated).toBe("Moved 1.000 recorded versions and verified the new location.");
  });
  it("keeps actual discovery and progress phrases intact", () => {
    expect(sourceDiscoveryResultSummary(0, 1, 1024)).toBe(
      "Found no exact matches. Checked 1 file or folder (1.0 KiB of verification data).",
    );
    expect(sourceDiscoveryResultSummary(2, 1000, 0)).toBe(
      "Found 2 exact matches. Checked 1,000 files and folders (0 B of verification data).",
    );
    expect(countMessage(0, "recoveryItems")).toBe(
      "No recovery items were recorded in the last check.",
    );
    expect(countMessage(1, "savedLocations")).toBe("1 saved file location will stay unchanged.");
    expect(countMessage(2, "pendingCleanup")).toContain("2 old folders");
    expect(
      progressPresentation(
        {
          schema_version: 3,
          operation_id: "count-progress",
          parent_operation_id: null,
          sequence: 1,
          timestamp_ms: 1,
          operation: "install",
          target: null,
          type: "progress",
          phase: "install",
          completed: 1,
          total: 2,
          unit: "ports",
        },
        "install",
      ).detail,
    ).toBe("1 of 2 ports");
    expect(
      progressPresentation(
        {
          schema_version: 3,
          operation_id: "count-progress",
          parent_operation_id: null,
          sequence: 1,
          timestamp_ms: 1,
          operation: "install",
          target: null,
          type: "progress",
          phase: "install",
          completed: 0,
          total: 1,
          unit: "items",
        },
        "install",
      ).detail,
    ).toBe("0 of 1 item");
  });
});

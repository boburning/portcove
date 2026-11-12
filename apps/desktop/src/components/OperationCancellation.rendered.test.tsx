import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { OperationCancellation } from "./OperationCancellation";

describe("operation cancellation", () => {
  it("uses operation-neutral waiting copy and distinguishes finishing", () => {
    const requested = renderToStaticMarkup(
      <OperationCancellation
        operationId="00000000-0000-0000-0000-000000000001"
        state={{ phase: "preparing", requested: true }}
      />,
    );
    expect(requested).toContain("Cancellation requested");
    expect(requested).toContain(
      "Portcove will stop after the current step reaches a safe stopping point.",
    );
    expect(requested).not.toContain("Waiting for the current safe step to stop.");
    expect(requested).not.toContain("preparation step");

    const finishing = renderToStaticMarkup(
      <OperationCancellation
        operationId="00000000-0000-0000-0000-000000000001"
        state={{ phase: "finishing", requested: false }}
      />,
    );
    expect(finishing).toContain("Finishing safely…");
    expect(finishing).not.toContain("Cancel operation");
  });

  it("renders the generic cancellation copy in the current language", async () => {
    const { initializeLocalization } = await import("../localization");
    const localization = initializeLocalization(["en-US"]);
    try {
      await localization.changeLanguage("ar-XB");
      const markup = renderToStaticMarkup(
        <OperationCancellation operationId="00000000-0000-0000-0000-000000000001" />,
      );
      expect(markup).toContain("إلغاء العملية");
      const labelled = renderToStaticMarkup(
        <OperationCancellation
          operationId="00000000-0000-0000-0000-000000000001"
          label="Caller label"
        />,
      );
      expect(labelled).toContain("Caller label");
    } finally {
      await localization.changeLanguage("en");
    }
  });
});

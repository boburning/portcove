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
});

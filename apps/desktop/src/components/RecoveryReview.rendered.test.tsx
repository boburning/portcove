import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { RecoveryReview } from "./RecoveryReview";
import { port } from "./rendered-test-fixtures";

describe("desktop components", () => {
  it("distinguishes never-loaded and stale recovery diagnostics from a healthy empty report", () => {
    const neverLoaded = renderToStaticMarkup(
      <RecoveryReview ports={[port]} refreshing={false} stale refresh={vi.fn()} />,
    );
    expect(neverLoaded).toContain('data-diagnostic-state="never-loaded"');
    expect(neverLoaded).toContain("has not been checked");
    expect(neverLoaded).toContain("Refresh recovery information");
    expect(neverLoaded).not.toContain("No recovery items were recorded");

    const stale = renderToStaticMarkup(
      <RecoveryReview
        ports={[port]}
        repair={{ generated_at: 1, items: [] }}
        refreshing
        stale
        refresh={vi.fn()}
      />,
    );
    expect(stale).toContain("last completed check remains visible");
    expect(stale).toContain("No recovery items were recorded");
  });
});

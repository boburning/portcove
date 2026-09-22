import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DesignCompatibilityFixture } from "./DesignCompatibilityFixture";

describe("DesignCompatibilityFixture", () => {
  it("uses the checked-in generated controls and a bundled offline asset", () => {
    const markup = renderToStaticMarkup(<DesignCompatibilityFixture />);
    expect(markup).toContain("Native compatibility fixture");
    expect(markup).toContain("data-offline-asset");
    expect(markup).toContain("/brand/icons/portcove-mascot-head-256.png");
    expect(markup).toContain("fixture-open-dialog");
    expect(markup).toContain("data-theme-variant-probe");
    expect(markup).toContain('data-theme="dark"');
    expect(markup).toContain('data-direction="ltr"');
    expect(markup).toContain('data-reduced-motion="false"');
    expect(markup).toContain('data-variant="selected"');
    expect(markup).toContain('data-variant="primary"');
  });
});

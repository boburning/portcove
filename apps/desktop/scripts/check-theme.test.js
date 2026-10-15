import { URL } from "node:url";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { semanticReferenceFailures, themeTokenFailures } from "./theme-tokens.mjs";
import { productionCssFailures } from "./production-css.mjs";
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
describe("theme tokens", () => {
  it("preserves branding, required aliases and text/control contrast in both themes", () => {
    const result = themeTokenFailures(css);
    expect(result.failures).toEqual([]);
    expect(result.results).toHaveLength(72);
  });
  it("rejects missing and cyclic semantic references", () => {
    expect(
      semanticReferenceFailures(
        new Map([
          ["--color-one", "var(--color-two)"],
          ["--color-two", "var(--color-one)"],
          ["--color-three", "var(--color-missing)"],
        ]),
      ),
    ).toEqual([
      "--color-one contains a cycle through --color-one",
      "--color-two contains a cycle through --color-two",
      "--color-three references missing token --color-missing",
    ]);
  });
  it("rejects weak contrast and a missing light override", () => {
    expect(
      themeTokenFailures(
        css.replace(/--color-text:\s*[^;]+;/gu, "--color-text: #191a1d;"),
      ).failures.some((failure) => failure.includes("needs 4.5")),
    ).toBe(true);
    expect(themeTokenFailures(css.replace(/--color-loading:\s*[^;]+;/gu, "")).failures).toContain(
      "light theme must explicitly override --color-loading",
    );
  });
  it("requires CSS emitted by the current build, including focus and destructive variants", () => {
    const emitted =
      ".bg-pc-signature{}.bg-pc-scrim{}.active\\:bg-pc-signature-active{}.hover\\:bg-pc-danger-surface{}.text-pc-danger-strong{}.focus-visible\\:ring-pc-ring{}[data-theme=dark]{}";
    expect(productionCssFailures(emitted)).toEqual([]);
    expect(productionCssFailures("")).not.toEqual([]);
    expect(productionCssFailures(emitted.replace(".focus-visible\\:ring-pc-ring{}", ""))).toEqual([
      "production CSS omits required selector .focus-visible\\:ring-pc-ring",
    ]);
  });
});

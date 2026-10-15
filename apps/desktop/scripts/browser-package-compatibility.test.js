import { describe, expect, it } from "vite-plus/test";
import { versions as bundled } from "vite-plus/versions";
import { URL, fileURLToPath } from "node:url";
import {
  assertBrowserPackageCompatibility,
  checkBrowserPackageCompatibility,
} from "./browser-package-compatibility.mjs";

function fixture() {
  const version = "5.0.3";
  return {
    declarations: { vitest: "^5.0.3", "@vitest/browser-playwright": version, playwright: "1.63.0" },
    manifests: {
      vitest: { name: "vitest", version },
      playwright: { name: "playwright", version: "1.63.0" },
      "@vitest/browser-playwright": {
        name: "@vitest/browser-playwright",
        version,
        peerDependencies: { vitest: version, playwright: "*" },
        dependencies: { "@vitest/browser": version, "@vitest/mocker": version },
      },
      "@vitest/browser": { name: "@vitest/browser", version },
      "@vitest/mocker": { name: "@vitest/mocker", version },
    },
  };
}

describe("installed browser package compatibility", () => {
  it("accepts the frozen installed core/provider and their provider-local dependencies", () => {
    const versions = checkBrowserPackageCompatibility(
      fileURLToPath(new URL("../package.json", import.meta.url)),
    );
    expect(versions.vitest).toBe(bundled.vitest);
    expect(versions["@vitest/browser-playwright"]).toBe(versions.vitest);
  });

  it("refuses a newer core permitted by its declared range but incompatible with the exact provider peer", () => {
    const { declarations, manifests } = fixture();
    manifests.vitest.version = "5.0.4";
    expect(() => assertBrowserPackageCompatibility(declarations, manifests)).toThrow(
      "exact installed Vitest peer",
    );
  });

  it.each(["vitest", "@vitest/browser-playwright", "playwright"])("refuses omitted %s", (name) => {
    const { declarations, manifests } = fixture();
    delete declarations[name];
    expect(() => assertBrowserPackageCompatibility(declarations, manifests)).toThrow(
      "missing or differs",
    );
  });

  it.each(["@vitest/browser", "@vitest/mocker"])("refuses mismatched provider-local %s", (name) => {
    const { declarations, manifests } = fixture();
    manifests[name].version = "5.0.2";
    expect(() => assertBrowserPackageCompatibility(declarations, manifests)).toThrow("must match");
  });

  it("refuses absent or range-only core peer metadata", () => {
    for (const peer of [undefined, "^5.0.3"]) {
      const { declarations, manifests } = fixture();
      manifests["@vitest/browser-playwright"].peerDependencies.vitest = peer;
      expect(() => assertBrowserPackageCompatibility(declarations, manifests)).toThrow(
        "exact installed Vitest peer",
      );
    }
  });

  it("refuses incompatible Playwright peer metadata", () => {
    const { declarations, manifests } = fixture();
    manifests["@vitest/browser-playwright"].peerDependencies.playwright = "<1.63.0";
    expect(() => assertBrowserPackageCompatibility(declarations, manifests)).toThrow(
      "compatible installed Playwright peer",
    );
  });
});

import { describe, expect, it } from "vite-plus/test";
import { versions as bundled } from "vite-plus/versions";
import { URL, fileURLToPath } from "node:url";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertBrowserPackageCompatibility,
  assertVitePlusCompatibility,
  checkBrowserPackageCompatibility,
} from "./browser-package-compatibility.mts";

function fixture() {
  const version = "5.0.3";
  const declarations: Partial<
    Record<"vitest" | "@vitest/browser-playwright" | "playwright", string>
  > = { vitest: "^5.0.3", "@vitest/browser-playwright": version, playwright: "1.63.0" };
  const peerDependencies: { vitest: string | undefined; playwright: string } = {
    vitest: version,
    playwright: "*",
  };
  return {
    declarations,
    manifests: {
      vitest: { name: "vitest", version },
      playwright: { name: "playwright", version: "1.63.0" },
      "@vitest/browser-playwright": {
        name: "@vitest/browser-playwright",
        version,
        peerDependencies,
        dependencies: { "@vitest/browser": version, "@vitest/mocker": version },
      },
      "@vitest/browser": { name: "@vitest/browser", version },
      "@vitest/mocker": { name: "@vitest/mocker", version },
    },
  };
}

describe("installed browser package compatibility", () => {
  it("rejects primary-only proposals and coordinated bundle mismatches", () => {
    const workspace = {
      catalog: {
        "vite-plus": "1.2.0",
        vite: "npm:@voidzero-dev/vite-plus-core@1.2.0",
        vitest: "5.0.4",
        "@vitest/browser-playwright": "5.0.4",
      },
      overrides: { "vite@*": "catalog:", "vitest@*": "catalog:" },
    };
    const manifests = {
      "vite-plus": { version: "1.2.0" },
      vite: { name: "@voidzero-dev/vite-plus-core", version: "1.2.0" },
      vitest: { version: "5.0.4" },
      "@vitest/browser-playwright": { version: "5.0.4" },
    };
    assertVitePlusCompatibility(workspace, manifests, { vitest: "5.0.4" });
    for (const key of ["vite-plus", "vite", "vitest", "@vitest/browser-playwright"] as const) {
      const proposal = { ...workspace, catalog: { ...workspace.catalog } };
      proposal.catalog[key] = "9.0.0";
      expect(() => assertVitePlusCompatibility(proposal, manifests, { vitest: "5.0.4" })).toThrow(
        /coordinated migration/,
      );
    }
    expect(() => assertVitePlusCompatibility(workspace, manifests, { vitest: "5.0.5" })).toThrow(
      /coordinated migration/,
    );
  });
  it("refuses a missing bundled version even when all corresponding metadata is absent", () => {
    expect(() =>
      assertVitePlusCompatibility(
        {
          catalog: { "vite-plus": "1.2.0", vite: "npm:@voidzero-dev/vite-plus-core@1.2.0" },
          overrides: { "vite@*": "catalog:", "vitest@*": "catalog:" },
        },
        {
          "vite-plus": { version: "1.2.0" },
          vite: { name: "@voidzero-dev/vite-plus-core", version: "1.2.0" },
        },
        {},
      ),
    ).toThrow(/coordinated migration/);
  });
  it("rejects nontext catalog references before loading installed packages", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "portcove-browser-graph-"));
    try {
      const app = path.join(root, "apps", "desktop");
      await mkdir(app, { recursive: true });
      await writeFile(
        path.join(app, "package.json"),
        JSON.stringify({ devDependencies: { vitest: "catalog:" } }),
      );
      await writeFile(path.join(root, "pnpm-workspace.yaml"), "catalog:\n  vitest: [5.0.4]\n");
      expect(() => checkBrowserPackageCompatibility(path.join(app, "package.json"))).toThrow(
        "text version",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
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

  it.each(["vitest", "@vitest/browser-playwright", "playwright"] as const)(
    "refuses omitted %s",
    (name) => {
      const { declarations, manifests } = fixture();
      delete declarations[name];
      expect(() => assertBrowserPackageCompatibility(declarations, manifests)).toThrow(
        "missing or differs",
      );
    },
  );

  it.each(["@vitest/browser", "@vitest/mocker"] as const)(
    "refuses mismatched provider-local %s",
    (name) => {
      const { declarations, manifests } = fixture();
      manifests[name].version = "5.0.2";
      expect(() => assertBrowserPackageCompatibility(declarations, manifests)).toThrow(
        "must match",
      );
    },
  );

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

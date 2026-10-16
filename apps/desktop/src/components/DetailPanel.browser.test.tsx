import { afterEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import axe from "axe-core";
import catalog from "../../../../crates/portcove-core/catalog/catalog.json";
import type { PortDefinition } from "../types";
import { fixtureValue } from "../test-fixtures";
import { DetailPanel, type DetailActions } from "./DetailPanel";

afterEach(cleanup);

for (const width of [1200, 960]) {
  it(`keeps primary actions next to the hero before optional route observations at ${width}px`, async () => {
    await page.viewport(width, 640);
    const port = fixtureValue(
      catalog.ports.find((port) => port.id === "snap64-recomp"),
      "Snap64",
    ) as unknown as PortDefinition;
    const actions: DetailActions = {
      activate: vi.fn(),
      backup: vi.fn(),
      check: vi.fn(async () => undefined),
      close: vi.fn(),
      deleteBackup: vi.fn(),
      dismissInstallReview: vi.fn(),
      install: vi.fn(),
      launch: vi.fn(),
      openUserData: vi.fn(),
      reviewInstall: vi.fn(),
      restoreBackup: vi.fn(),
      rollback: vi.fn(),
      remove: vi.fn(),
      setChannel: vi.fn(async () => undefined),
      setPolicy: vi.fn(async () => undefined),
      verify: vi.fn(),
    };
    await render(
      <DetailPanel
        port={port}
        sourcePath=""
        setSourcePath={vi.fn()}
        actions={actions}
        libraryGeneration={1}
      />,
    );
    const hero = document.querySelector(".detail-hero")!;
    const action = document.querySelector(".primary-actions button")!;
    const gap = action.getBoundingClientRect().top - hero.getBoundingClientRect().bottom;
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThan(160);
    const routeCheck = page.getByRole("heading", { name: "Game files for this route" });
    expect(routeCheck.element().getBoundingClientRect().top).toBeGreaterThan(
      action.getBoundingClientRect().bottom,
    );
    for (const details of document.querySelectorAll("details")) details.open = true;
    const accessibility = await axe.run(document.body, {
      runOnly: { type: "rule", values: ["landmark-unique", "heading-order"] },
    });
    expect(accessibility.violations.map((violation) => violation.id)).toEqual([]);
  });
}

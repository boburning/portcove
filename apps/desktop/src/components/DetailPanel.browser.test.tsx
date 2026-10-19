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
    await page.getByText("File and filter details", { exact: true }).click();
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

it.each(["dark", "light"])(
  "keeps recorded catalog scope in real details without current matches in %s",
  async (theme) => {
    document.documentElement.dataset.theme = theme;
    await page.viewport(520, 780);
    const port = fixtureValue(
      catalog.ports.find((port) => port.id === "snap64-recomp"),
      "Snap64",
    ) as unknown as PortDefinition;
    const noop = vi.fn();
    const actions: DetailActions = {
      activate: noop,
      backup: noop,
      check: async () => undefined,
      close: noop,
      deleteBackup: noop,
      dismissInstallReview: noop,
      install: noop,
      launch: noop,
      openUserData: noop,
      reviewInstall: noop,
      restoreBackup: noop,
      rollback: noop,
      remove: noop,
      setChannel: async () => undefined,
      setPolicy: async () => undefined,
      verify: noop,
    };
    const observation = {
      lastAccepted: {
        observedAt: 1700000000,
        expiresAt: 1700000300,
        deadline: 12345,
        routes: [
          {
            port_id: port.id,
            route: "external_registration" as const,
            platform: "linux-x86-64" as const,
            channel: "beta" as const,
          },
        ],
      },
      usable: false,
      expired: true,
      outcome: "failed" as const,
    };
    const root = await render(
      <DetailPanel
        port={port}
        sourcePath=""
        setSourcePath={noop}
        actions={actions}
        gameFileObservation={observation}
      />,
    );
    for (const details of document.querySelectorAll("details")) details.open = true;
    const metadata = page.getByLabelText("Catalog check history").element();
    expect(metadata.textContent).toContain("Previous check");
    expect(metadata.textContent).toContain("Existing installation setup · Linux · Preview");
    expect(metadata.textContent).toContain("Filters → Check game-file filters");
    expect(document.querySelector('[aria-label="Catalog game-file observation"]')).toBeNull();
    expect(document.body.textContent).not.toContain("Complete set:");
    await page.screenshot({
      element: metadata.parentElement!,
      path: `../../../../outputs/observation-clarity/details-history-${theme}-520.png`,
    });
    await root.rerender(
      <DetailPanel
        port={{ ...port, id: "outside-request" }}
        sourcePath=""
        setSourcePath={noop}
        actions={actions}
        gameFileObservation={observation}
      />,
    );
    expect(document.querySelector('[aria-label="Catalog check history"]')).toBeNull();
    expect(noop).not.toHaveBeenCalled();
    delete document.documentElement.dataset.theme;
  },
);

import { afterEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import { currentCatalogPort } from "../catalog-test-fixtures";
import { portStatus } from "../test-fixtures";
import { DetailPanel } from "./DetailPanel";
import { PortBrowser } from "./PortBrowser";
import { actions, installRecord } from "./rendered-test-fixtures";

afterEach(cleanup);

// The retained Windows trace spent most of the default 5s in first-render/browser
// round trips before clicking the visible, enabled control. Keep assertions and
// zero retries; allow this fixture 15s while other cases retain their budgets.
it(
  "names the Library setup action accessibly and opens the game's details",
  {
    timeout: /Windows/u.test(navigator.userAgent) ? 15_000 : 5_000,
  },
  async () => {
    const port = currentCatalogPort("re-rac-rerac");
    const select = vi.fn();
    const status = {
      ...portStatus(),
      port_id: port.id,
      active: installRecord({ port_id: port.id }),
      readiness: {
        launchable: false,
        pending_setup: true,
        blockers: ["preparation_required" as const],
      },
      port_actions: [
        {
          action: "launch" as const,
          availability: "waiting" as const,
          reason: "preparation_required" as const,
          definition: null,
        },
      ],
    };
    await render(
      <PortBrowser
        view="library"
        ports={[port]}
        statuses={new Map([[port.id, status]])}
        overview={{ installed: 1, ready: 0, needsSetup: 1, staged: 0 }}
        filter="all"
        setFilter={vi.fn()}
        onSelect={select}
        loading={false}
      />,
    );
    const finish = page.getByRole("button", { name: /^Review setup:/ });
    await expect.element(finish).toHaveTextContent("Review setup");
    await finish.click();
    expect(select).toHaveBeenCalledWith(port.id, expect.any(String), "files");
  },
);

it.each([null, "game-data/extract-info.json"])(
  "continues retained manual setup even when the current definition marker is %s",
  async (marker) => {
    const port = { ...currentCatalogPort("re-rac-rerac"), setup_marker: marker };
    const open = vi.fn();
    const refresh = vi.fn();
    const launch = vi.fn();
    await render(
      <DetailPanel
        port={port}
        status={{
          ...portStatus(),
          port_id: port.id,
          active: installRecord({ port_id: port.id }),
          readiness: {
            launchable: false,
            pending_setup: true,
            blockers: ["preparation_required"],
          },
        }}
        sourcePath=""
        setSourcePath={vi.fn()}
        actions={{ ...actions, openSetupFolder: open, launch }}
        externalRuntimeChanged={refresh}
      />,
    );
    const region = page.getByRole("region", { name: "Game actions", exact: true });
    await region.getByRole("button", { name: "Finish setup", exact: true }).click();
    expect(open).toHaveBeenCalledTimes(1);
    expect(launch).not.toHaveBeenCalled();
    await region.getByRole("button", { name: "Check setup again", exact: true }).click();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(
      region.getByRole("button", { name: "Play unavailable", exact: true }).query(),
    ).toBeNull();
  },
);

import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import axe from "axe-core";
import { currentCatalogPort } from "../catalog-test-fixtures";
import { portDefinition, portStatus, sourceProfile, fixtureValue } from "../test-fixtures";
import { DetailPanel, type DetailActions } from "./DetailPanel";
import { actions as detailActions, installRecord } from "./rendered-test-fixtures";
import type { ReadinessBlocker, SourceHealth } from "../types";
import "../styles/index.css";

afterEach(cleanup);

function installedSourceDetail(
  id: string,
  health: SourceHealth,
  blockers: ReadinessBlocker[] = [],
) {
  const port = currentCatalogPort(id);
  const profile = { ...sourceProfile(), id: fixtureValue(port.source_profile, "original profile") };
  const source = {
    profile_id: profile.id,
    path: "C:/Player/original.bin",
    sha256: "a".repeat(64),
    size: 32,
    storage_sha256: "a".repeat(64),
    storage_size: 32,
    updated_at: 1,
  };
  return {
    port,
    source,
    sourceProfile: profile,
    sourcePath: source.path,
    setSourcePath: vi.fn(),
    inspectSource: vi.fn(),
    actions: { ...detailActions, launch: vi.fn() },
    status: {
      ...portStatus(),
      port_id: port.id,
      active: installRecord({ port_id: port.id }),
      readiness: {
        source: health,
        launchable: blockers.length === 0,
        pending_setup: false,
        blockers,
      },
    },
  };
}

for (const id of ["road-rash-64-recompiled", "sonic-3-and-knuckles-recomp"]) {
  for (const width of [480, 1100]) {
    it(`keeps explicit Play for metadata-only registered originals: ${id} at ${width}px`, async () => {
      await page.viewport(width, 780);
      const props = installedSourceDetail(id, "not_checked");
      await render(<DetailPanel {...props} />);
      expect(props.actions.launch).not.toHaveBeenCalled();
      expect(props.inspectSource).not.toHaveBeenCalled();
      expect(
        page.getByRole("button", { name: "Select game files", exact: true }).query(),
      ).toBeNull();
      const play = document.querySelector<HTMLButtonElement>("[data-launch-action]");
      expect(play).not.toBeNull();
      expect(play!.disabled).toBe(false);
      expect(play!.textContent?.trim()).toMatch(/^(Play|Try launch)$/);
      if (width === 1100) {
        play!.focus();
        await userEvent.keyboard("{Enter}");
      } else await userEvent.click(play!);
      expect(props.actions.launch).toHaveBeenCalledOnce();
      expect(props.inspectSource).not.toHaveBeenCalled();
    });
  }
}

it.each([
  ["missing", "missing_source"],
  ["unreadable", "unreadable_source"],
  ["changed", "changed_source"],
  ["not_checked", "incompatible_source"],
] as const)("preserves Core's %s original refusal", async (health, blocker) => {
  const props = installedSourceDetail("road-rash-64-recompiled", health, [blocker]);
  await render(<DetailPanel {...props} />);
  expect(document.querySelector("[data-launch-action]:not(:disabled)")).toBeNull();
  await expect
    .element(page.getByRole("button", { name: "Select game files", exact: true }))
    .toBeVisible();
  expect(props.actions.launch).not.toHaveBeenCalled();
});

it("asks only for missing BIOS when the registered game has metadata-only health", async () => {
  const props = installedSourceDetail("mortal-kombat-4-recompiled", "not_checked", [
    "missing_bios",
  ]);
  await render(
    <DetailPanel
      {...props}
      status={{ ...props.status, readiness: { ...props.status.readiness, bios: "missing" } }}
      biosProfile={{
        ...sourceProfile(),
        id: fixtureValue(props.port.bios_source_profile, "BIOS profile"),
      }}
      biosPath=""
      setBiosPath={vi.fn()}
    />,
  );
  await expect
    .element(page.getByRole("button", { name: "Select BIOS file", exact: true }))
    .toBeVisible();
  expect(page.getByRole("button", { name: "Select game files", exact: true }).query()).toBeNull();
  expect(document.querySelector("[data-launch-action]:not(:disabled)")).toBeNull();
});

it("keeps Core's allowed launch while source-record readback is pending", async () => {
  const props = installedSourceDetail("road-rash-64-recompiled", "not_checked");
  await render(<DetailPanel {...props} source={undefined} sourcePath="" />);
  expect(document.querySelector("[data-launch-action]:not(:disabled)")).not.toBeNull();
  expect(page.getByRole("button", { name: "Select game files", exact: true }).query()).toBeNull();
  expect(props.actions.launch).not.toHaveBeenCalled();
  expect(props.inspectSource).not.toHaveBeenCalled();
});

it("keeps an unknown external installation's folder and maintenance facts distinct from readiness", async () => {
  await page.viewport(960, 640);
  const port = portDefinition();
  const noop = vi.fn();
  const status = {
    ...portStatus(),
    external_runtime: {
      id: "external-owned-fixture",
      port_id: port.id,
      path: "C:\\Player\\External Folder",
      executable: "C:\\Player\\External Folder\\game.exe",
      version: "1",
      platform: "windows-x86-64" as const,
      archive_sha256: "a".repeat(64),
      immutable_tree_sha256: "b".repeat(64),
      registered_at: 1,
    },
  };
  await render(
    <DetailPanel
      port={port}
      status={status}
      sourcePath=""
      setSourcePath={noop}
      actions={{
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
      }}
    />,
  );
  // Folder ownership is a Manage fact; selecting it never establishes launch readiness.
  expect(document.querySelector("[data-detail-readiness]")?.textContent).toContain(
    "Readiness unavailable",
  );
  await page.getByRole("tab", { name: "Manage", exact: true }).click();
  const ownership = page.getByRole("heading", { name: "Installation management", exact: true });
  await expect.element(ownership).toBeVisible();
  const facts = page.elementLocator(ownership.element().closest("section")!);
  await expect
    .element(facts.getByText(status.external_runtime.path, { exact: true }))
    .toBeVisible();
  await expect
    .element(facts.getByText("You maintain this folder and its updates.", { exact: true }))
    .toBeVisible();
  expect(
    document.querySelector('[data-confirmed-play]:not(:disabled):not([aria-disabled="true"])'),
  ).toBeNull();
  expect(
    page.getByRole("region", { name: "Installation and version", exact: true }).query(),
  ).toBeNull();
  await page.screenshot({
    element: document.querySelector<HTMLElement>("[data-detail-workspace]")!,
    path: "../../../../outputs/detail-composition/unknown-external-960.png",
  });
});

for (const width of [1200, 960]) {
  it(`keeps the current action with full identity before optional route observations at ${width}px`, async () => {
    await page.viewport(width, 640);
    const port = currentCatalogPort("snap64-recomp");
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
    const action = document.querySelector(".detail-header-actions button")!;
    expect(hero.contains(action)).toBe(true);
    const title = document.getElementById("port-detail-title")!;
    expect(action.getBoundingClientRect().top).toBeGreaterThan(
      title.getBoundingClientRect().bottom,
    );
    await page.getByText("File matching details", { exact: true }).click();
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
    const port = currentCatalogPort("snap64-recomp");
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

it.each([
  [360, "dark"],
  [740, "light"],
] as const)(
  "names a first-run launch without implying preparation at %ipx in %s with enlarged text",
  async (width, theme) => {
    await page.viewport(width, 800);
    const fontSize = document.documentElement.style.fontSize;
    const oldTheme = document.documentElement.dataset.theme;
    document.documentElement.style.fontSize = "20.8px";
    document.documentElement.dataset.theme = theme;
    const launch = vi.fn(async () => true);
    const install = vi.fn(async () => true);
    const reviewInstall = vi.fn();
    try {
      await render(
        <DetailPanel
          port={portDefinition()}
          status={{
            ...portStatus(),
            active: installRecord(),
            readiness: { launchable: true, pending_setup: true, blockers: [] },
          }}
          sourcePath=""
          setSourcePath={vi.fn()}
          actions={{ ...detailActions, launch, install, reviewInstall }}
        />,
      );
      const action = page.getByRole("button", { name: "Launch to finish setup", exact: true });
      await expect.element(action).toBeVisible();
      const element = action.element();
      expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth + 1);
      expect(element.getBoundingClientRect().right).toBeLessThanOrEqual(width + 1);
      await action.click();
      expect(launch).toHaveBeenCalledOnce();
      expect(install).not.toHaveBeenCalled();
      expect(reviewInstall).not.toHaveBeenCalled();
    } finally {
      document.documentElement.style.fontSize = fontSize;
      if (oldTheme === undefined) delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = oldTheme;
    }
  },
);

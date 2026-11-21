import { captureParityState } from "../../test/parity-capture";
import { expectDisclosureAlignment } from "../../test/disclosure-alignment";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import axe from "axe-core";
import { desktopApi } from "../api";
import * as filePicker from "../file-picker";
import { currentCatalogPort } from "../catalog-test-fixtures";
import { portDefinition, portStatus, sourceProfile, fixtureValue } from "../test-fixtures";
import { DetailPanel, type DetailActions } from "./DetailPanel";
import { actions as detailActions, installRecord } from "./rendered-test-fixtures";
import type { PortOutputLocation, ReadinessBlocker, SourceHealth } from "../types";
import "../styles/index.css";

afterEach(cleanup);
vi.mock("../file-picker", { spy: true });

it.each([
  { theme: "dark", savedArguments: ["--fullscreen"] },
  { theme: "light", savedArguments: ["--profile", "", "first\nsecond"] },
])(
  "preserves external Manage launch facts and their edit identity in compact RTL $theme",
  async ({ theme, savedArguments }) => {
    const oldTheme = document.documentElement.dataset.theme;
    const oldViewport = { width: innerWidth, height: innerHeight };
    const port = portDefinition();
    const executable = String.raw`\\?\C:\Player\External runtime installations\نسخة محفوظة\Original game folder\game.exe`;
    const directory = String.raw`\\مخدم\ألعاب\External runtime installations\Original game folder`;
    const record = {
      id: "manage-selected-runtime",
      port_id: port.id,
      path: directory,
      executable,
      version: "user-managed",
      platform: "windows-x86-64" as const,
      archive_sha256: "",
      immutable_tree_sha256: "",
      registered_at: 1,
      user_selected: { arguments: savedArguments },
    };
    const preview = vi
      .spyOn(desktopApi, "previewUserSelectedRuntimeRelink")
      .mockRejectedValue(new Error("Read-only consumer fixture: review reached"));
    const mutations = [
      vi
        .spyOn(desktopApi, "registerUserSelectedRuntime")
        .mockRejectedValue(new Error("Unexpected mutation")),
      vi
        .spyOn(desktopApi, "relinkUserSelectedRuntime")
        .mockRejectedValue(new Error("Unexpected mutation")),
      vi
        .spyOn(desktopApi, "removeExternalRuntime")
        .mockRejectedValue(new Error("Unexpected mutation")),
      vi.spyOn(desktopApi, "launch").mockRejectedValue(new Error("Unexpected launch")),
    ];
    const launch = vi.fn();
    await page.viewport(430, 896);
    document.documentElement.dataset.theme = theme;
    try {
      await render(
        <div dir="rtl" style={{ padding: 16 }}>
          <DetailPanel
            port={port}
            status={{ ...portStatus(), external_runtime: record }}
            sourcePath=""
            setSourcePath={vi.fn()}
            actions={{ ...detailActions, launch }}
            libraryGeneration={19}
          />
        </div>,
      );
      await page.getByRole("tab", { name: "Manage", exact: true }).click();
      const heading = page.getByRole("heading", { name: "External installation", exact: true });
      await expect.element(heading).toBeVisible();
      const facts = heading.element().closest("section")!.querySelector("dl")!;
      expect(getComputedStyle(facts).direction).toBe("rtl");
      expect([...facts.querySelectorAll("dt")].map((label) => label.textContent)).toEqual([
        "Game program",
        "Start in folder",
        "Launch options (advanced)",
      ]);
      const paths = [...facts.querySelectorAll<HTMLElement>("dd.path-value")];
      expect(paths.map((value) => value.textContent)).toEqual([executable, directory]);
      expect([...facts.querySelectorAll("code")].map((value) => value.textContent)).toEqual(
        savedArguments.filter(Boolean),
      );
      expect(facts.textContent?.includes("Empty argument")).toBe(savedArguments.includes(""));
      for (const argument of facts.querySelectorAll("code")) {
        expect(getComputedStyle(argument).whiteSpace).toBe("pre-wrap");
      }
      facts.scrollIntoView({ block: "center" });
      await document.fonts.ready;
      for (const value of [...paths, ...facts.querySelectorAll("code")]) {
        expect(value.getAttribute("dir")).toBe("ltr");
        expect(getComputedStyle(value).direction).toBe("ltr");
        expect(getComputedStyle(value).unicodeBidi).not.toContain("override");
        const bounds = value.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(value);
        for (const rect of [...range.getClientRects()].filter((rect) => rect.width > 0)) {
          expect(rect.left).toBeGreaterThanOrEqual(0);
          expect(rect.right).toBeLessThanOrEqual(innerWidth);
          expect(rect.top).toBeGreaterThanOrEqual(0);
          expect(rect.bottom).toBeLessThanOrEqual(innerHeight);
          expect(rect.left).toBeGreaterThanOrEqual(bounds.left - 1);
          expect(rect.right).toBeLessThanOrEqual(bounds.right + 1);
        }
      }
      const prefix = document.createRange();
      prefix.setStart(paths[0]!.firstChild!, 0);
      prefix.setEnd(paths[0]!.firstChild!, 7);
      expect(prefix.toString()).toBe("\\\\?\\C:\\");
      expect(prefix.getClientRects()).toHaveLength(1);
      const serverPrefix = [0, 1, 2].map((index) => {
        const glyph = document.createRange();
        glyph.setStart(paths[1]!.firstChild!, index);
        glyph.setEnd(paths[1]!.firstChild!, index + 1);
        return glyph.getBoundingClientRect().top;
      });
      expect(directory.slice(0, 3)).toBe("\\\\م");
      expect(Math.max(...serverPrefix) - Math.min(...serverPrefix)).toBeLessThanOrEqual(1);
      expect(preview).not.toHaveBeenCalled();
      await captureParityState("detail-manage-selected-launch-facts");
      await page.getByRole("button", { name: "Open launch details", exact: true }).click();
      await expect
        .element(page.getByRole("tab", { name: "Game files", exact: true }))
        .toHaveAttribute("aria-selected", "true");
      expect(
        document.querySelector("[data-detail-workspace]")?.getAttribute("data-detail-port-id"),
      ).toBe(port.id);
      const edit = page.getByRole("button", { name: "Edit launch details…", exact: true });
      await expect.element(edit).toHaveFocus();
      expect(preview).not.toHaveBeenCalled();
      await edit.click();
      await expect
        .element(page.getByRole("textbox", { name: "Start in folder", exact: true }))
        .toHaveValue(directory);
      await page.getByRole("button", { name: "Review launch details", exact: true }).click();
      await expect
        .poll(() => preview.mock.calls)
        .toEqual([[port.id, executable, directory, savedArguments, 19]]);
      for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled();
      expect(launch).not.toHaveBeenCalled();
    } finally {
      preview.mockRestore();
      for (const mutation of mutations) mutation.mockRestore();
      if (oldTheme === undefined) delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = oldTheme;
      await page.viewport(oldViewport.width, oldViewport.height);
    }
  },
);

it.each([false, true])("opens prepared folder controls while busy is %s", async (busy) => {
  const port = portDefinition();
  const record = {
    id: "prepared-folder",
    port_id: port.id,
    path: "C:/Games/Prepared copy",
    executable: "C:/Games/Prepared copy/game.exe",
    version: "1.2.3",
    platform: "windows-x86-64" as const,
    archive_sha256: "a".repeat(64),
    immutable_tree_sha256: "b".repeat(64),
    registered_at: 1,
  };
  const picker = vi.spyOn(filePicker, "pickInstallFolder").mockResolvedValue(null);
  await render(
    <DetailPanel
      port={port}
      status={{ ...portStatus(), external_runtime: record }}
      sourcePath=""
      setSourcePath={vi.fn()}
      actions={detailActions}
      libraryGeneration={19}
      busy={busy ? "Checking the installation" : undefined}
    />,
  );
  await page.getByRole("tab", { name: "Manage", exact: true }).click();
  await page.getByRole("button", { name: "Open game folder controls", exact: true }).click();
  const change = page.getByRole("button", { name: "Change game folder…", exact: true });
  await expect.element(change).toBeVisible();
  expect(change.element().matches(":disabled")).toBe(busy);
  const destination = busy ? page.getByRole("region", { name: "Game actions" }) : change;
  await expect.element(destination).toHaveFocus();
  expect(picker).not.toHaveBeenCalled();
  picker.mockRestore();
});

it.each(["dark", "light"] as const)(
  "aligns all padded disclosure markers to the first wrapped line in %s",
  async (theme) => {
    const oldTheme = document.documentElement.dataset.theme;
    const oldFontSize = document.documentElement.style.fontSize;
    const oldViewport = { width: innerWidth, height: innerHeight };
    await page.viewport(430, 780);
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.fontSize = "16px";
    try {
      await render(
        <div style={{ inlineSize: 260, padding: 16 }}>
          {["ltr", "rtl"].map((direction) => (
            <section key={direction} dir={direction}>
              {[1, 2, 3].map((spacing) => (
                <details key={spacing}>
                  <summary className={`disclosure-pad-${spacing}`}>
                    {direction === "rtl"
                      ? "تفاصيل التثبيت ونتائج الفحص والملفات المحفوظة"
                      : "Installation details, recorded checks and preserved game files"}
                  </summary>
                  <p>Recorded details remain separate from current checks.</p>
                </details>
              ))}
            </section>
          ))}
        </div>,
      );
      await document.fonts.ready;
      const summaries = [...document.querySelectorAll<HTMLElement>("summary")];
      expect(summaries).toHaveLength(6);
      for (const [index, summary] of summaries.entries()) {
        // Retain the existing 4/8/12 px hit-area padding as well as the drawn alignment.
        const padding = [4, 8, 12][index % 3];
        expect(parseFloat(getComputedStyle(summary).paddingBlockStart)).toBe(padding);
        expect(parseFloat(getComputedStyle(summary).paddingBlockEnd)).toBe(padding);
        const text = document.createRange();
        text.selectNodeContents(summary);
        expect(text.getClientRects().length).toBeGreaterThan(1);
        expectDisclosureAlignment(summary);
        expect(summary.scrollWidth).toBeLessThanOrEqual(summary.clientWidth + 1);
        summary.focus();
        await userEvent.keyboard("{Enter}");
        expect(summary.closest("details")!.open).toBe(true);
        expectDisclosureAlignment(summary);
        await userEvent.keyboard("{Enter}");
        expect(summary.closest("details")!.open).toBe(false);
      }
      await captureParityState("disclosure-spacing-wrapped-ltr-rtl");
    } finally {
      document.documentElement.style.fontSize = oldFontSize;
      if (oldTheme === undefined) delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = oldTheme;
      await page.viewport(oldViewport.width, oldViewport.height);
    }
  },
);

it.each(["dark", "light"] as const)(
  "aligns the actual Versions future-preferences disclosure in %s",
  async (theme) => {
    const oldTheme = document.documentElement.dataset.theme;
    const oldViewport = { width: innerWidth, height: innerHeight };
    await page.viewport(430, 780);
    document.documentElement.dataset.theme = theme;
    try {
      const props = installedSourceDetail("road-rash-64-recompiled", "not_checked");
      props.actions.check = vi.fn();
      await render(<DetailPanel {...props} />);
      await page.getByRole("tab", { name: "Versions & updates", exact: true }).click();
      const summary = page.getByText("Future update preferences", { exact: true });
      await expect.element(summary).toBeVisible();
      summary.element().scrollIntoView({ block: "center" });
      await document.fonts.ready;
      expectDisclosureAlignment(summary.element());
      summary.element().focus();
      await userEvent.keyboard("{Enter}");
      expect(summary.element().closest("details")!.open).toBe(true);
      expectDisclosureAlignment(summary.element());
      await expect.element(page.getByText(/Saving them does not run an update/)).toBeVisible();
      await userEvent.keyboard("{Enter}");
      expect(summary.element().closest("details")!.open).toBe(false);
      expect(document.activeElement).toBe(summary.element());
      const bounds = summary.element().getBoundingClientRect();
      expect(bounds.top).toBeGreaterThanOrEqual(0);
      expect(bounds.bottom).toBeLessThanOrEqual(innerHeight);
      await captureParityState("versions-future-preferences-disclosure-aligned");
      expect(props.actions.check).not.toHaveBeenCalled();
      expect(props.actions.launch).not.toHaveBeenCalled();
    } finally {
      if (oldTheme === undefined) delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = oldTheme;
      await page.viewport(oldViewport.width, oldViewport.height);
    }
  },
);

function expectManualSummaryGeometry(label: Element, direction: "ltr" | "rtl") {
  const summary = fixtureValue(label.closest("summary"), "manual summary");
  const text = fixtureValue(summary.querySelector<HTMLElement>(":scope > span"), "summary text");
  const icon = fixtureValue(summary.querySelector<SVGSVGElement>(":scope > svg"), "manual chevron");
  summary.scrollIntoView({ block: "center", behavior: "instant" });
  const bounds = summary.getBoundingClientRect();
  const textBounds = text.getBoundingClientRect();
  const iconBounds = icon.getBoundingClientRect();
  const style = getComputedStyle(summary);
  const titleRange = document.createRange();
  titleRange.selectNodeContents(label);
  const firstLine = fixtureValue([...titleRange.getClientRects()][0], "first title line");
  const trailingDistance =
    direction === "rtl"
      ? Math.abs(iconBounds.left - bounds.left - parseFloat(style.paddingLeft))
      : Math.abs(bounds.right - parseFloat(style.paddingRight) - iconBounds.right);
  expect(trailingDistance).toBeLessThanOrEqual(1);
  expect(
    Math.abs((iconBounds.top + iconBounds.bottom) / 2 - (firstLine.top + firstLine.bottom) / 2),
  ).toBeLessThanOrEqual(2);
  expect(iconBounds.width).toBeGreaterThan(0);
  expect(iconBounds.height).toBeGreaterThan(0);
  expect(iconBounds.left).toBeGreaterThanOrEqual(bounds.left);
  expect(iconBounds.right).toBeLessThanOrEqual(bounds.right);
  expect(iconBounds.top).toBeGreaterThanOrEqual(bounds.top);
  expect(iconBounds.bottom).toBeLessThanOrEqual(bounds.bottom);
  const textRange = document.createRange();
  textRange.selectNodeContents(text);
  for (const line of textRange.getClientRects()) {
    expect(line.left).toBeGreaterThanOrEqual(textBounds.left - 1);
    expect(line.right).toBeLessThanOrEqual(textBounds.right + 1);
  }
  expect(summary.scrollWidth).toBeLessThanOrEqual(summary.clientWidth + 1);
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.bottom).toBeLessThanOrEqual(innerHeight);
}

async function chooseDetailSection(label: string, narrow: boolean) {
  if (narrow) {
    await page.getByRole("combobox", { name: /^Game detail sections/ }).click();
    await page.getByRole("option", { name: label, exact: true }).click();
  } else {
    await page.getByRole("tab", { name: label, exact: true }).click();
  }
}

it.each(
  ([430, 960] as const).flatMap((width) =>
    (["dark", "light"] as const).flatMap((theme) =>
      (["ltr", "rtl"] as const).map((direction) => ({ width, theme, direction })),
    ),
  ),
)(
  "keeps actual manual summaries attached to their first text row in $theme $direction at $width",
  async ({ width, theme, direction }) => {
    const oldTheme = document.documentElement.dataset.theme;
    const oldViewport = { width: innerWidth, height: innerHeight };
    const folderError = "Owned manual-summary folder read unavailable";
    const read = vi.spyOn(desktopApi, "outputLocation").mockRejectedValue(new Error(folderError));
    const relocation = vi.spyOn(desktopApi, "outputRelocationStatus").mockResolvedValue(null);
    const apply = vi
      .spyOn(desktopApi, "setOutputLocation")
      .mockRejectedValue(new Error("No apply expected"));
    const reset = vi
      .spyOn(desktopApi, "resetOutputLocation")
      .mockRejectedValue(new Error("No reset expected"));
    const props = {
      ...installedSourceDetail("opengoal-jak1", "not_checked", ["preparation_required"]),
      source: undefined,
      sourcePath: "",
    };
    props.status.readiness.pending_setup = true;
    props.actions.install = vi.fn();
    props.actions.reviewInstall = vi.fn();
    try {
      await page.viewport(width, 780);
      document.documentElement.dataset.theme = theme;
      await render(
        <div dir={direction} style={{ inlineSize: width === 430 ? 260 : 704 }}>
          <DetailPanel {...props} busy="Owned operation still pending" />
        </div>,
      );
      await document.fonts.ready;
      await chooseDetailSection("Game files", width === 430);
      const requirements = page.getByText("Current game-file requirements", { exact: true });
      await expect.element(requirements).toBeVisible();
      expect(requirements.element().closest("details")).toBeNull();
      requirements.element().scrollIntoView({ block: "center", behavior: "instant" });
      const requirementsBounds = requirements.element().getBoundingClientRect();
      expect(requirementsBounds.top).toBeGreaterThanOrEqual(0);
      expect(requirementsBounds.bottom).toBeLessThanOrEqual(innerHeight);
      expect(requirementsBounds.left).toBeGreaterThanOrEqual(0);
      expect(requirementsBounds.right).toBeLessThanOrEqual(innerWidth);
      if (direction === "ltr") await captureParityState("detail-current-game-file-requirements");
      await chooseDetailSection("Manage", width === 430);
      for (const title of ["Folder for a future install", "Technical details"]) {
        const control = page.getByText(title, { exact: true });
        await expect.element(control).toBeVisible();
        const label = control.element();
        const summary = fixtureValue(label.closest("summary"), "manual summary");
        const details = fixtureValue(summary.closest("details"), "manual details");
        const originalOpen = details.open;
        expectManualSummaryGeometry(label, direction);
        summary.focus();
        await userEvent.keyboard("{Enter}");
        expect(details.open).toBe(!originalOpen);
        expect(document.activeElement).toBe(summary);
        expectManualSummaryGeometry(label, direction);
        await userEvent.keyboard("{Enter}");
        expect(details.open).toBe(originalOpen);
        expect(document.activeElement).toBe(summary);
        expectManualSummaryGeometry(label, direction);
      }
      await page.getByText("Folder for a future install", { exact: true }).click();
      await expect.element(page.getByText(folderError, { exact: false })).toBeVisible();
      const technical = page.getByText("Technical details", { exact: true }).element();
      expectManualSummaryGeometry(technical, direction);
      if (direction === "ltr") await captureParityState("detail-manual-summary-trailing-chevron");
      expect(apply).not.toHaveBeenCalled();
      expect(reset).not.toHaveBeenCalled();
      expect(props.actions.install).not.toHaveBeenCalled();
      expect(props.actions.reviewInstall).not.toHaveBeenCalled();
      expect(props.actions.launch).not.toHaveBeenCalled();
      expect(props.inspectSource).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
      relocation.mockRestore();
      apply.mockRestore();
      reset.mockRestore();
      if (oldTheme === undefined) delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = oldTheme;
      await page.viewport(oldViewport.width, oldViewport.height);
    }
  },
);

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

it("shows why the last launch failed on an installed game's details page, with Open Activity", async () => {
  const props = installedSourceDetail("road-rash-64-recompiled", "not_checked");
  const installId = props.status.active.id;
  vi.spyOn(desktopApi, "launchFailure").mockResolvedValue({
    id: "launch-1",
    install_id: installId,
    exit_code: -1073741515,
    outcome: "failed",
    exit_explanation: {
      table_version: 1,
      key: "dll_not_found",
      raw_code: "0xC0000135",
      explanation: "A required DLL or runtime is most likely missing.",
      next_action: "Check the game's page for a Microsoft runtime to install, then try again.",
    },
  } as never);
  const openActivity = vi.fn();
  await render(<DetailPanel {...props} libraryGeneration={3} openActivity={openActivity} />);
  await expect
    .element(page.getByText("A required DLL or runtime is most likely missing."))
    .toBeVisible();
  expect(desktopApi.launchFailure).toHaveBeenCalledWith(props.port.id, 3);
  await page.getByRole("button", { name: "Open Activity", exact: true }).first().click();
  expect(openActivity).toHaveBeenCalled();
});

it("refreshes the explanation when a launch finishes on the open details page", async () => {
  const props = installedSourceDetail("road-rash-64-recompiled", "not_checked");
  const load = vi.spyOn(desktopApi, "launchFailure").mockResolvedValue(null);
  const view = await render(<DetailPanel {...props} libraryGeneration={3} />);
  await expect.poll(() => load.mock.calls.length).toBeGreaterThan(0);
  expect(document.querySelector("[data-launch-failure]")).toBeNull();

  load.mockResolvedValue({
    id: "launch-7",
    install_id: props.status.active.id,
    exit_code: 7,
    outcome: "failed",
    exit_explanation: {
      table_version: 1,
      key: "unexplained_exit",
      raw_code: "7",
      explanation: "The game closed with an error.",
      next_action: "Try launching again.",
    },
  } as never);
  await view.rerender(
    <DetailPanel {...props} libraryGeneration={3} finishedLaunchActivityId="activity-7" />,
  );
  await expect.element(page.getByText("The game closed with an error.")).toBeVisible();

  load.mockResolvedValue(null);
  await view.rerender(
    <DetailPanel {...props} libraryGeneration={3} finishedLaunchActivityId="activity-8" />,
  );
  await expect.element(page.getByText("The game closed with an error.")).not.toBeInTheDocument();
});

it("keeps the saved disc by default and starts an explicitly chosen disc", async () => {
  vi.spyOn(desktopApi, "launchFailure").mockResolvedValue(null);
  const props = installedSourceDetail("alexbeav-ace-combat-3-electrosphere-recomp", "current");
  const status = {
    ...props.status,
    readiness: { ...props.status.readiness, selectable_discs: 2 },
  };
  await render(<DetailPanel {...props} status={status} />);
  const play = document.querySelector<HTMLButtonElement>("[data-launch-action]");
  expect(play).not.toBeNull();
  await userEvent.click(play!);
  expect(props.actions.launch).toHaveBeenLastCalledWith(undefined);
  for (const [from, to, sent] of [
    ["Saved disc", "Disc 2", 2],
    ["Disc 2", "Disc 1", 1],
  ] as const) {
    await page.getByRole("combobox", { name: `Disc to start ${from}` }).click();
    await page.getByRole("option", { name: to, exact: true }).click();
    await expect.element(page.getByRole("combobox", { name: `Disc to start ${to}` })).toBeVisible();
    await userEvent.click(play!);
    expect(props.actions.launch).toHaveBeenLastCalledWith(sent);
  }
});

it("shows no launch-failure notice when the last launch has nothing to explain", async () => {
  const props = installedSourceDetail("road-rash-64-recompiled", "not_checked");
  vi.spyOn(desktopApi, "launchFailure").mockResolvedValue(null);
  await render(<DetailPanel {...props} libraryGeneration={3} />);
  await expect.poll(() => vi.mocked(desktopApi.launchFailure).mock.calls.length).toBeGreaterThan(0);
  expect(document.querySelector("[data-launch-failure]")).toBeNull();
});

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

it.each(["game", "bios"] as const)(
  "reviews an unregistered selected %s path without registering or installing it",
  async (input) => {
    const port = currentCatalogPort("mortal-kombat-4-recompiled");
    const reviewInstall = vi.fn();
    const install = vi.fn();
    const launch = vi.fn();
    const status = {
      ...portStatus(),
      port_id: port.id,
      active: null,
      readiness: {
        launchable: false,
        pending_setup: false,
        source: "unregistered" as const,
        bios: "unregistered" as const,
        blockers: [input === "game" ? ("missing_source" as const) : ("missing_bios" as const)],
      },
      port_actions: [
        {
          action: "install" as const,
          availability: "waiting" as const,
          reason: input === "game" ? ("missing_source" as const) : ("missing_bios" as const),
        },
      ],
    };
    await render(
      <DetailPanel
        port={port}
        status={status}
        sourcePath="C:/Player/selected-game.bin"
        setSourcePath={vi.fn()}
        biosPath="C:/Player/selected-bios.bin"
        setBiosPath={vi.fn()}
        actions={{ ...detailActions, reviewInstall, install, launch }}
      />,
    );
    const review = page.getByRole("button", { name: "Review installation", exact: true });
    await expect.element(review).toBeVisible();
    await review.click();
    expect(reviewInstall).toHaveBeenCalledOnce();
    expect(install).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    expect(document.querySelector("[data-launch-action]")).toBeNull();
  },
);

for (const input of ["game", "bios"] as const) {
  it.each(["missing", "unreadable", "changed", "incompatible", "saved"] as const)(
    `keeps ${input} install review unavailable for a %s input`,
    async (failure) => {
      const props = installedSourceDetail("mortal-kombat-4-recompiled", "unregistered");
      const blocker =
        `${failure === "saved" ? "missing" : failure}_${input === "game" ? "source" : "bios"}` as ReadinessBlocker;
      await render(
        <DetailPanel
          {...props}
          source={input === "game" && failure === "saved" ? props.source : undefined}
          bios={input === "bios" && failure === "saved" ? props.source : undefined}
          biosPath="C:/Player/selected-bios.bin"
          setBiosPath={vi.fn()}
          status={{
            ...props.status,
            active: null,
            readiness: {
              launchable: false,
              pending_setup: false,
              source: input === "game" && failure === "missing" ? "missing" : "unregistered",
              bios: input === "bios" && failure === "missing" ? "missing" : "unregistered",
              blockers: [input === "game" ? "missing_source" : "missing_bios", blocker],
            },
          }}
        />,
      );
      expect(
        page.getByRole("button", { name: "Review installation", exact: true }).query(),
      ).toBeNull();
      expect(document.querySelector("[data-launch-action]:not(:disabled)")).toBeNull();
      expect(props.actions.launch).not.toHaveBeenCalled();
    },
  );
}

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

it("offers a read-only Check again as the primary action while setup is unknown", async () => {
  const port = { ...portDefinition(), source_profile: null, bios_source_profile: null };
  const noop = vi.fn();
  let settle: () => void = () => undefined;
  const checkAgain = vi.fn(() => new Promise<void>((resolve) => (settle = resolve)));
  const actions = {
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
  await render(
    <DetailPanel
      port={port}
      status={undefined}
      sourcePath=""
      setSourcePath={noop}
      checkAgain={checkAgain}
      actions={actions}
    />,
  );
  expect(document.querySelector("[data-detail-readiness]")?.textContent).toContain(
    "Can't check right now",
  );
  const check = page.getByRole("button", { name: "Check again", exact: true });
  await expect.element(check).toHaveAttribute("data-variant", "primary");
  const deferred = [...document.querySelectorAll<HTMLButtonElement>("button")].filter((button) =>
    /^(Install|Finish setup)\b/.test(button.textContent ?? ""),
  );
  expect(deferred.length).toBeGreaterThan(0);
  expect(deferred.map((button) => button.dataset.variant)).toEqual(deferred.map(() => "outline"));
  await check.click();
  await expect.element(page.getByRole("button", { name: "Checking…", exact: true })).toBeDisabled();
  settle();
  await expect
    .element(page.getByRole("button", { name: "Check again", exact: true }))
    .toBeEnabled();
  expect(checkAgain).toHaveBeenCalledTimes(1);
  expect(actions.install).not.toHaveBeenCalled();
});

it("keeps the unknown setup state without Check again when no reread is available", async () => {
  const port = { ...portDefinition(), source_profile: null, bios_source_profile: null };
  const noop = vi.fn();
  await render(
    <DetailPanel
      port={port}
      status={undefined}
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
  expect(document.querySelector("[data-detail-readiness]")?.textContent).toContain(
    "Can't check right now",
  );
  expect(page.getByRole("button", { name: "Check again", exact: true }).query()).toBeNull();
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
    "Can't check right now",
  );
  await page.getByRole("tab", { name: "Manage", exact: true }).click();
  const ownership = page.getByRole("heading", { name: "External installation", exact: true });
  await expect.element(ownership).toBeVisible();
  const facts = page.elementLocator(ownership.element().closest("section")!);
  await expect
    .element(facts.getByText(status.external_runtime.path, { exact: true }))
    .toBeVisible();
  await expect
    .element(facts.getByText(status.external_runtime.executable, { exact: true }))
    .toBeVisible();
  await expect
    .element(
      facts.getByText(
        "You maintain this folder and its updates. Review Saves & backups for any data Portcove can protect.",
        { exact: true },
      ),
    )
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
    const routeCheck = page.getByRole("heading", {
      name: "Game files for this setup or launch option",
    });
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
    expect(document.querySelector('[aria-label="Game-file filter results"]')).toBeNull();
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

it("routes the saved-update summary action to the existing activation review owner", async () => {
  const port = portDefinition();
  const active = installRecord({ port_id: port.id });
  const activate = vi.fn();
  await render(
    <DetailPanel
      port={port}
      status={{
        ...portStatus(),
        port_id: port.id,
        active,
        staged: { ...active, id: "saved", version: "2.0", staged: true },
      }}
      sourcePath=""
      setSourcePath={vi.fn()}
      actions={{ ...detailActions, activate }}
    />,
  );
  await page.getByRole("tab", { name: "Versions & updates", exact: true }).click();
  const summary = page.getByRole("region", { name: "Installation and release versions" });
  await summary.getByRole("button", { name: "Apply update · 2.0", exact: true }).click();
  expect(activate).toHaveBeenCalledOnce();
  expect(page.getByRole("button", { name: "Update now", exact: true }).query()).toBeNull();
  expect(page.getByRole("button", { name: "Download for later", exact: true }).query()).toBeNull();
});

it.each(["busy", "missing_runtime", "invalid_installation"] as const)(
  "keeps simultaneous hero notices and staged activation safety in the %s renderer fixture",
  async (state) => {
    await page.viewport(960, 800);
    const port = { ...portDefinition(), source_profile: null };
    const mods = vi.spyOn(desktopApi, "modSetups").mockResolvedValue({
      held_updates: [],
      inventory: null,
      later_mods_take_priority: false,
      live: null,
      package_types: [],
      port_id: port.id,
      provider: null,
      supported: false,
    });
    const active = installRecord({ port_id: port.id });
    const activate = vi.fn();
    const launch = vi.fn();
    const busy = state === "busy";
    await render(
      <DetailPanel
        port={port}
        status={{
          ...portStatus(),
          port_id: port.id,
          active,
          staged: { ...active, id: "saved", version: "2.0", staged: true },
          readiness: {
            launchable: busy,
            pending_setup: false,
            blockers: busy ? [] : [state],
          },
        }}
        busy={busy ? "activating staged update" : undefined}
        sourcePath=""
        setSourcePath={vi.fn()}
        actions={{ ...detailActions, activate, launch }}
      />,
    );
    const hero = document.querySelector<HTMLElement>(".detail-hero")!;
    const notices = document.querySelector<HTMLElement>(".detail-attention")!;
    expect(notices.querySelectorAll(".detail-notice-row")).toHaveLength(2);
    expect(notices.querySelector("[data-update-attention]")?.textContent).toContain(
      "Update saved for later · 2.0",
    );
    const primary = hero.querySelector<HTMLButtonElement>(".detail-header-actions button")!;
    expect(primary.disabled || primary.getAttribute("aria-disabled") === "true").toBe(busy);
    expect(notices.textContent?.includes("Working: activating staged update.")).toBe(busy);
    expect(
      notices.querySelector(busy ? '[role="status"]' : "[data-detail-reason]")?.textContent?.trim(),
    ).toBeTruthy();
    // Damaged or runtime-blocked installs have no remaining setup to finish.
    expect(primary.textContent).toContain(busy ? "Play" : "Review game files");
    await captureParityState(`detail-hero-${state}-and-staged-fixture`);
    await page.getByRole("tab", { name: "Versions & updates", exact: true }).click();
    const apply = page.getByRole("button", { name: "Apply update · 2.0", exact: true });
    await expect.element(apply).toBeVisible();
    expect((apply.element() as HTMLButtonElement).disabled).toBe(busy);
    expect(activate).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    mods.mockRestore();
  },
);

it("opens actual Overview evidence and future-folder controls in a renderer fixture", async () => {
  await page.viewport(960, 900);
  const port = { ...portDefinition(), source_profile: null };
  const location: PortOutputLocation = {
    port_id: port.id,
    library_root: "E:/Portcove",
    default_output_directory: "E:/Portcove/versions/sample",
    configured_output_directory: null,
    effective_output_directory: "E:/Portcove/versions/sample",
    selection_source: "library_default",
    user_data_root: "E:/Portcove/user/sample",
  };
  const read = vi.spyOn(desktopApi, "outputLocation").mockResolvedValue(location);
  const relocation = vi.spyOn(desktopApi, "outputRelocationStatus").mockResolvedValue(null);
  const preview = vi.spyOn(desktopApi, "previewOutputLocation").mockResolvedValue({
    port_id: port.id,
    current: location,
    proposed: location,
    reset_to_default: true,
    availability: "available",
    ownership: "library_default",
    available_bytes: 8 * 1024 ** 3,
    total_bytes: 16 * 1024 ** 3,
    volume_identity: "fixture-volume",
    validation_errors: [],
    affected_installs: [],
    moves_existing_install: false,
    preview_sha256: "a".repeat(64),
  });
  try {
    await render(
      <DetailPanel
        port={port}
        sourcePath=""
        setSourcePath={vi.fn()}
        actions={detailActions}
        libraryGeneration={7}
      />,
    );
    const overview = page.getByRole("tab", { name: "Overview", exact: true });
    await overview.click();
    await expect.element(overview).toHaveAttribute("aria-selected", "true");
    for (const [label, expected, name] of [
      [
        "Project status and release information",
        "Catalog designation (not a test result)",
        "project",
      ],
      ["Platforms and installation method", "Installation method", "compatibility"],
      ["Test results", "These are earlier test results", "recorded-checks"],
    ] as const) {
      const summary = page.getByText(label, { exact: true });
      await summary.click();
      const disclosure = summary.element().closest("details")!;
      expect(disclosure.open).toBe(true);
      expect(disclosure.textContent).toContain(expected);
      summary.element().scrollIntoView({ block: "start" });
      await captureParityState(`detail-overview-${name}-expanded-fixture`);
    }
    await page.getByRole("tab", { name: "Manage", exact: true }).click();
    const folder = page.getByText("Folder for a future install", { exact: true });
    await folder.click();
    const disclosure = folder.element().closest("details")!;
    expect(disclosure.open).toBe(true);
    await expect
      .element(page.getByLabelText("Folder for future installs", { exact: true }))
      .toHaveValue(location.effective_output_directory);
    await expect.poll(() => disclosure.textContent).toContain("8.0 GiB available of 16.0 GiB");
    expect(disclosure.textContent).toContain(
      "Choosing an output folder does not move or install a game.",
    );
    expect(read).toHaveBeenCalledWith(port.id, 7);
    expect(preview).toHaveBeenCalledWith(port.id, null, 7);
    folder.element().scrollIntoView({ block: "start" });
    await captureParityState("detail-manage-future-folder-expanded-fixture");
  } finally {
    read.mockRestore();
    relocation.mockRestore();
    preview.mockRestore();
  }
});

it("keeps a setup-needed game's file details inside a 400% interface-size column", async () => {
  // At 400% a 960 px window leaves the details column about 164 CSS px wide (#4879).
  await page.viewport(240, 640);
  const port = currentCatalogPort("opengoal-jak1");
  const props = {
    ...installedSourceDetail("opengoal-jak1", "not_checked", ["preparation_required"]),
    source: undefined,
    sourcePath: "",
  };
  props.status = {
    ...props.status,
    port_id: port.id,
    readiness: { ...props.status.readiness, pending_setup: true },
  };
  await render(
    <div data-testid="narrow-details-column" style={{ inlineSize: 164 }}>
      <DetailPanel {...props} />
    </div>,
  );
  await chooseDetailSection("Game files", true);
  const column = page.getByTestId("narrow-details-column").element();
  await expect.poll(() => column.querySelector(".requirements-body") !== null).toBe(true);
  expect(column.scrollWidth).toBeLessThanOrEqual(column.clientWidth);
});

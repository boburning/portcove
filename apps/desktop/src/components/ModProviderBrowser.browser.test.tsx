import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { desktopApi } from "../api";
import type { ProviderBrowsePage, ProviderInstallPlan, ProviderProjectView } from "../types";
import { ModProviderBrowser } from "./ModProviderBrowser";
import "../styles/index.css";

const mounted: { root: Root; host: HTMLElement }[] = [];
afterEach(async () => {
  for (const { root, host } of mounted.splice(0)) {
    await act(async () => root.unmount());
    host.remove();
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const browse = (freshness = "fresh") =>
  ({
    port_id: "shipwright",
    game_name: "Ship of Harkinian",
    last_page: 50,
    other_game_records: 0,
    provider: "gamebanana",
    page: {
      projects: [
        {
          provider: "gamebanana",
          project_id: "42",
          name: "HD Link",
          version: "2.0",
          game_id: "16121",
          updated_at: 5,
          obsolete: false,
          profile_url: "",
          submitter: null,
          files: [],
          unreadable_files: 0,
        },
      ],
      total: 41,
      page: 1,
      complete: false,
    },
    observed_at: 0,
    freshness,
  }) as unknown as ProviderBrowsePage;

const project = (freshness = "fresh") =>
  ({
    port_id: "shipwright",
    game_name: "Ship of Harkinian",
    project: {
      ...browse().page.projects[0],
      files: [
        {
          file_id: "10",
          file_name: "pack.zip",
          size: 4096,
          added_at: 4,
          download_url: "",
          claimed_md5: null,
          archived: false,
          claimed_scan: "clean",
        },
      ],
      unreadable_files: 1,
    },
    observed_at: 0,
    freshness,
  }) as unknown as ProviderProjectView;

const plan = {
  port_id: "shipwright",
  profile_id: "default",
  project_name: "HD Link",
  file: { file_id: "10", file_name: "pack.zip" },
  download_size: 4096,
  download_sha256: "c".repeat(64),
  ignored_entries: 1,
  conflicts_truncated: false,
  members: [{ file_name: "hd-link.o2r", sha256: "a".repeat(64), size: 2048, asset_count: 1 }],
  replaces: ["HD Link.otr"],
  conflicts: [],
  unverified_claims: ["GameBanana's MD5"],
  plan_sha256: "b".repeat(64),
} as unknown as ProviderInstallPlan;

async function render(
  onInstalled = vi.fn(),
  options: { disabled?: boolean; onBusyChange?: (busy: boolean) => void } = {},
) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () =>
    root.render(
      <ModProviderBrowser
        portId="shipwright"
        generation={7}
        profileId="default"
        profileName="Default"
        inUse
        disabled={options.disabled ?? false}
        onBusyChange={options.onBusyChange ?? (() => {})}
        onInstalled={onInstalled}
      />,
    ),
  );
  return { host, root };
}

function button(host: HTMLElement, label: string) {
  const found = [...host.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`missing button ${label}`);
  return found;
}

it("browses, reviews a file and installs only the confirmed plan", async () => {
  const browsed = vi.spyOn(desktopApi, "browseProviderMods").mockResolvedValue(browse());
  vi.spyOn(desktopApi, "providerProject").mockResolvedValue(project());
  const planned = vi.spyOn(desktopApi, "planProviderInstall").mockResolvedValue(plan);
  const applied = vi
    .spyOn(desktopApi, "applyProviderInstall")
    .mockResolvedValue({} as Awaited<ReturnType<typeof desktopApi.applyProviderInstall>>);
  const onInstalled = vi.fn();
  const { host } = await render(onInstalled);

  await act(async () => button(host, "Find mods on GameBanana…").click());
  expect(browsed).toHaveBeenCalledWith("shipwright", 1, 7);
  expect(host.textContent).toContain("show that a mod works with this game");
  await act(async () => button(host, "Show files of HD Link").click());
  expect(host.textContent).toContain("pack.zip (4.0 KiB)");
  expect(host.textContent).toContain("1 more file on GameBanana couldn’t be read safely");
  expect(applied).not.toHaveBeenCalled();

  await act(async () => button(host, "Review pack.zip").click());
  expect(planned).toHaveBeenCalledWith("shipwright", "default", 42, 10, 7);
  expect(host.textContent).toContain("Replaces your installed HD Link.otr");
  expect(host.textContent).toContain("GameBanana's MD5");
  expect(host.textContent).toContain("game’s mods folder changes as soon as you install");
  expect(host.textContent).toContain("1 other entry in the download isn’t a mod package");
  expect(applied).not.toHaveBeenCalled();

  await act(async () => button(host, "Install").click());
  expect(applied).toHaveBeenCalledWith("shipwright", "default", plan.plan_sha256, plan, 7);
  expect(onInstalled).toHaveBeenCalledWith("Installed hd-link.o2r from HD Link into Default.");
});

it("cancelling a review discards it and stale data offers no review", async () => {
  vi.spyOn(desktopApi, "browseProviderMods").mockResolvedValue(browse());
  const projectRead = vi.spyOn(desktopApi, "providerProject").mockResolvedValueOnce(project());
  vi.spyOn(desktopApi, "planProviderInstall").mockResolvedValue(plan);
  const discarded = vi.spyOn(desktopApi, "discardProviderInstall").mockResolvedValue(undefined);
  const applied = vi.spyOn(desktopApi, "applyProviderInstall");
  const { host } = await render();
  await act(async () => button(host, "Find mods on GameBanana…").click());
  await act(async () => button(host, "Show files of HD Link").click());
  await act(async () => button(host, "Review pack.zip").click());
  await act(async () => button(host, "Cancel").click());
  expect(discarded).toHaveBeenCalledWith("shipwright", plan, 7);
  expect(applied).not.toHaveBeenCalled();

  projectRead.mockResolvedValueOnce(project("stale"));
  await act(async () => button(host, "Back to mods").click());
  await act(async () => button(host, "Show files of HD Link").click());
  expect(host.textContent).toContain("couldn’t be reached, so this is earlier data");
  expect([...host.querySelectorAll("button")].some((b) => b.textContent?.includes("Review"))).toBe(
    false,
  );
});

it("reports a refused review as an alert and changes nothing", async () => {
  vi.spyOn(desktopApi, "browseProviderMods").mockResolvedValue(browse());
  vi.spyOn(desktopApi, "providerProject").mockResolvedValue(project());
  vi.spyOn(desktopApi, "planProviderInstall").mockRejectedValue(
    new Error("this project does not belong to the game this port is bound to"),
  );
  const applied = vi.spyOn(desktopApi, "applyProviderInstall");
  const { host } = await render();
  await act(async () => button(host, "Find mods on GameBanana…").click());
  await act(async () => button(host, "Show files of HD Link").click());
  await act(async () => button(host, "Review pack.zip").click());
  expect(host.querySelector("[role=alert]")?.textContent).toContain("does not belong");
  expect(applied).not.toHaveBeenCalled();
});

it("discards an open review when the view goes away and reports work to the panel", async () => {
  vi.spyOn(desktopApi, "browseProviderMods").mockResolvedValue(browse());
  vi.spyOn(desktopApi, "providerProject").mockResolvedValue(project());
  vi.spyOn(desktopApi, "planProviderInstall").mockResolvedValue(plan);
  const discarded = vi.spyOn(desktopApi, "discardProviderInstall").mockResolvedValue(undefined);
  const busy = vi.fn();
  const { host, root } = await render(vi.fn(), { onBusyChange: busy });
  await act(async () => button(host, "Find mods on GameBanana…").click());
  await act(async () => button(host, "Show files of HD Link").click());
  await act(async () => button(host, "Review pack.zip").click());
  expect(busy).toHaveBeenLastCalledWith(true);
  await act(async () => root.unmount());
  mounted.splice(0);
  host.remove();
  expect(discarded).toHaveBeenCalledWith("shipwright", plan, 7);
  expect(busy).toHaveBeenLastCalledWith(false);
});

it("a refused install drops the review and asks for a new one", async () => {
  vi.spyOn(desktopApi, "browseProviderMods").mockResolvedValue(browse());
  vi.spyOn(desktopApi, "providerProject").mockResolvedValue(project());
  vi.spyOn(desktopApi, "planProviderInstall").mockResolvedValue({
    ...plan,
    conflicts: [
      { path: "objects/link.bin", providers: ["mine.o2r", "hd-link.o2r"], winner: "hd-link.o2r" },
    ],
    conflicts_truncated: true,
  });
  const discarded = vi.spyOn(desktopApi, "discardProviderInstall").mockResolvedValue(undefined);
  vi.spyOn(desktopApi, "applyProviderInstall").mockRejectedValue(
    new Error("the profile changed after review; plan again"),
  );
  const { host } = await render();
  await act(async () => button(host, "Find mods on GameBanana…").click());
  await act(async () => button(host, "Show files of HD Link").click());
  await act(async () => button(host, "Review pack.zip").click());
  expect(host.textContent).toContain("hd-link.o2r wins in the current order");
  expect(host.textContent).toContain("More shared files exist than are listed here.");
  await act(async () => button(host, "Install").click());
  expect(host.querySelector("[role=alert]")?.textContent).toContain("Review the file again.");
  expect(discarded).toHaveBeenCalled();
  expect([...host.querySelectorAll("button")].some((b) => b.textContent === "Install")).toBe(false);
});

it("a failed first check can be retried or closed, and disabled blocks every change", async () => {
  const browsed = vi
    .spyOn(desktopApi, "browseProviderMods")
    .mockRejectedValueOnce(new Error("GameBanana could not be reached"))
    .mockResolvedValue(browse());
  const { host } = await render();
  await act(async () => button(host, "Find mods on GameBanana…").click());
  expect(host.querySelector("[role=alert]")?.textContent).toContain("could not be reached");
  await act(async () => button(host, "Check GameBanana again").click());
  expect(browsed).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain("HD Link");
  await act(async () => button(host, "Close").click());
  expect(button(host, "Find mods on GameBanana…")).toBeTruthy();

  const disabled = await render(vi.fn(), { disabled: true });
  expect(button(disabled.host, "Find mods on GameBanana…").disabled).toBe(true);
});

it("presents the browser in the active locale with provider text kept exact", async () => {
  const { initializeLocalization } = await import("../localization");
  const localization = initializeLocalization(["en-US"]);
  try {
    await localization.changeLanguage("ar-XB");
    vi.spyOn(desktopApi, "browseProviderMods").mockResolvedValue(browse());
    const { host } = await render();
    await act(async () => button(host, "ابحث عن تعديلات في GameBanana…").click());
    expect(host.querySelector("h4")?.textContent).toBe("تعديلات GameBanana لـ Default");
    expect(host.textContent).toContain("HD Link (2.0)");
    expect(button(host, "عرض ملفات HD Link")).toBeTruthy();
  } finally {
    await localization.changeLanguage("en");
  }
});

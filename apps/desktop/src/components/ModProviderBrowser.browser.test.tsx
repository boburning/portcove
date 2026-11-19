import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { desktopApi } from "../api";
import type {
  ProviderBrowsePage,
  ProviderInstallPlan,
  ProviderProjectView,
  ProviderUpdateObservation,
} from "../types";
import { ModProviderBrowser } from "./ModProviderBrowser";
import type { ModUpdateControlProps } from "./ModUpdateControl";
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
  options: {
    disabled?: boolean;
    onBusyChange?: (busy: boolean) => void;
    provider?: string;
    portId?: string;
    updates?: Pick<ModUpdateControlProps, "policy" | "setPolicy" | "automaticChecks">;
  } = {},
) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () =>
    root.render(
      <ModProviderBrowser
        portId={options.portId ?? "shipwright"}
        provider={options.provider ?? "gamebanana"}
        generation={7}
        profileId="default"
        profileName="Default"
        inUse
        disabled={options.disabled ?? false}
        onBusyChange={options.onBusyChange ?? (() => {})}
        onInstalled={onInstalled}
        {...(options.updates ? { updates: options.updates } : {})}
      />,
    ),
  );
  return { host, root };
}

it("keeps the update check focused and announces results that fit a compact panel", async () => {
  let resolveCheck!: (observations: ProviderUpdateObservation[]) => void;
  const pending = new Promise<ProviderUpdateObservation[]>((resolve) => {
    resolveCheck = resolve;
  });
  const check = vi.spyOn(desktopApi, "checkProviderModUpdates").mockReturnValue(pending);
  const { host } = await render(vi.fn(), {
    updates: { policy: "review_updates", setPolicy: vi.fn(), automaticChecks: [] },
  });
  host.style.inlineSize = "430px";
  const trigger = page.getByRole("button", { name: "Check for mod updates" });
  const checking = page.getByRole("button", { name: "Checking for mod updates…" });
  await act(async () => trigger.click());
  await expect.element(checking).toHaveFocus();
  await expect.element(checking).toHaveAttribute("aria-busy", "true");
  await act(async () =>
    resolveCheck([
      {
        freshness: "fresh",
        installed_version: "1.0",
        native_id: "LongRegisteredModName".repeat(10) + ".o2r",
        newer_files: [],
        observed_version: "1.0",
        provider: { provider: "gamebanana", project: "42" },
        reason: null,
        state: "current",
        version_changed: false,
      },
    ]),
  );
  await expect.element(page.getByRole("status")).toHaveTextContent("Mod update check results");
  await expect.element(page.getByRole("list", { name: "Mod update check results" })).toBeVisible();
  expect(host.scrollWidth).toBe(host.clientWidth);
  await expect.element(trigger).toHaveFocus();
  expect(check).toHaveBeenCalledExactlyOnceWith("shipwright", "default", 7);
});

it("recovers a failed update review by reopening the exact provider project", async () => {
  const previous = {
    ...project(),
    project: {
      ...project().project,
      project_id: "41",
      name: "Previous project",
      files: project().project.files.map((file) => ({ ...file, file_name: "previous.zip" })),
    },
  };
  const listing = browse();
  const browsePage = vi.spyOn(desktopApi, "browseProviderMods").mockResolvedValue({
    ...listing,
    page: { ...listing.page, projects: [previous.project] },
  });
  const read = vi
    .spyOn(desktopApi, "providerProject")
    .mockResolvedValueOnce(previous)
    .mockRejectedValueOnce(new Error("Provider unavailable."))
    .mockResolvedValueOnce(project());
  await render(vi.fn(), {
    updates: {
      policy: "automatic_eligible",
      setPolicy: vi.fn(),
      automaticChecks: [
        {
          profile_id: "default",
          native_ids: ["hd.o2r"],
          project_id: "42",
          candidate_file_id: "10",
          checked_at: 1_700_000_000,
          result: { outcome: "held", reason: "Review this update." },
        },
      ],
    },
  });
  await act(async () => page.getByRole("button", { name: "Find mods on GameBanana…" }).click());
  await act(async () =>
    page.getByRole("button", { name: "Show files of Previous project" }).click(),
  );
  const previousReview = page.getByRole("button", { name: "Review previous.zip" });
  await expect.element(previousReview).toBeVisible();
  await act(async () => page.getByRole("button", { name: "Review update files" }).click());
  const heading = page.getByRole("heading", { name: "Mods on GameBanana for Default" });
  await expect.element(heading).toHaveFocus();
  await expect.element(page.getByRole("alert")).toHaveTextContent("Provider unavailable.");
  await expect.element(previousReview).not.toBeInTheDocument();
  await act(async () => page.getByRole("button", { name: "Check GameBanana again" }).click());
  await expect.element(heading).toHaveFocus();
  await expect.element(page.getByRole("button", { name: "Review pack.zip" })).toBeVisible();
  expect(read.mock.calls).toEqual([
    ["shipwright", "41", 7, "gamebanana"],
    ["shipwright", "42", 7, "gamebanana"],
    ["shipwright", "42", 7, "gamebanana"],
  ]);
  expect(browsePage).toHaveBeenCalledExactlyOnceWith("shipwright", 1, 7, "gamebanana");
});

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
  expect(browsed).toHaveBeenCalledWith("shipwright", 1, 7, "gamebanana");
  expect(host.textContent).toContain("show that a mod works with this game");
  await act(async () => button(host, "Show files of HD Link").click());
  expect(host.textContent).toContain("pack.zip (4.0 KiB)");
  expect(host.textContent).toContain("1 more file on GameBanana couldn’t be read safely");
  expect(applied).not.toHaveBeenCalled();

  await act(async () => button(host, "Review pack.zip").click());
  expect(planned).toHaveBeenCalledWith("shipwright", "default", "42", "10", 7, "gamebanana");
  expect(host.textContent).toContain("Replaces your installed HD Link.otr");
  expect(host.textContent).toContain("GameBanana's MD5");
  expect(host.textContent).toContain("game’s mods folder changes as soon as you install");
  expect(host.textContent).toContain("1 other entry in the download isn’t a mod package");
  expect(applied).not.toHaveBeenCalled();

  await act(async () => button(host, "Install").click());
  expect(applied).toHaveBeenCalledWith("shipwright", "default", plan.plan_sha256, plan, 7, false);
  expect(onInstalled).toHaveBeenCalledWith("Installed hd-link.o2r from HD Link into Default.");
});

it("shows unconfirmed file eligibility without offering an install review", async () => {
  vi.spyOn(desktopApi, "browseProviderMods").mockResolvedValue(browse());
  const details = project();
  details.project.files[0]!.status_unknown = "omitted";
  vi.spyOn(desktopApi, "providerProject").mockResolvedValue(details);
  const planned = vi.spyOn(desktopApi, "planProviderInstall");
  const { host } = await render();

  await act(async () => button(host, "Find mods on GameBanana…").click());
  await act(async () => button(host, "Show files of HD Link").click());
  await expect.element(page.getByText("pack.zip", { exact: true })).toBeVisible();
  await expect.element(page.getByText(/The provider did not confirm availability/)).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Review pack.zip" }))
    .not.toBeInTheDocument();
  expect(planned).not.toHaveBeenCalled();
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

it("names Thunderstore and asks before installing a reviewed mod that runs code", async () => {
  const thunderPage = {
    ...browse(),
    port_id: "zelda64-recomp",
    game_name: "Zelda 64: Recompiled",
    provider: "thunderstore",
    page: {
      ...browse().page,
      projects: [
        {
          ...browse().page.projects[0],
          provider: "thunderstore",
          project_id: "Owner-Timer",
          name: "Timer",
          version: "1.1.0",
        },
      ],
    },
  } as unknown as ProviderBrowsePage;
  vi.spyOn(desktopApi, "browseProviderMods").mockResolvedValue(thunderPage);
  const projectView = {
    ...project(),
    port_id: "zelda64-recomp",
    project: {
      ...thunderPage.page.projects[0],
      files: [
        { ...project().project.files[0], file_id: "1.1.0", file_name: "Owner-Timer-1.1.0.zip" },
      ],
      unreadable_files: 0,
    },
  } as unknown as ProviderProjectView;
  const projectRead = vi.spyOn(desktopApi, "providerProject").mockResolvedValue(projectView);
  const codePlan = {
    ...plan,
    port_id: "zelda64-recomp",
    project_name: "Timer",
    replaces: [],
    unverified_claims: [],
    wrappers: [
      {
        provider: { provider: "thunderstore", project: "Tools-Shared", file: "2.1.0" },
        file: { file_id: "2.1.0" },
        members: { "shared.nrm": "b".repeat(64) },
      },
      {
        provider: { provider: "thunderstore", project: "Owner-Timer", file: "1.1.0" },
        file: { file_id: "1.1.0" },
        members: { "speed_timer.nrm": "a".repeat(64) },
      },
    ],
    members: [
      {
        file_name: "speed_timer.nrm",
        sha256: "a".repeat(64),
        size: 2048,
        asset_count: 0,
        runs_code: ["recompiled_code"],
      },
    ],
  } as unknown as ProviderInstallPlan;
  const planned = vi.spyOn(desktopApi, "planProviderInstall").mockResolvedValue(codePlan);
  const applied = vi
    .spyOn(desktopApi, "applyProviderInstall")
    .mockResolvedValue({} as Awaited<ReturnType<typeof desktopApi.applyProviderInstall>>);
  const { host } = await render(vi.fn(), { provider: "thunderstore", portId: "zelda64-recomp" });

  await act(async () => button(host, "Find mods on Thunderstore…").click());
  expect(host.textContent).not.toContain("GameBanana");
  await act(async () => button(host, "Show files of Timer").click());
  expect(projectRead).toHaveBeenCalledWith("zelda64-recomp", "Owner-Timer", 7, "thunderstore");
  await act(async () => button(host, "Review Owner-Timer-1.1.0.zip").click());
  expect(planned).toHaveBeenCalledWith(
    "zelda64-recomp",
    "default",
    "Owner-Timer",
    "1.1.0",
    7,
    "thunderstore",
  );
  expect(host.textContent).toContain("speed_timer.nrm runs its own code inside the game");
  expect(host.textContent).toContain("Tools-Shared (2.1.0)");
  expect(host.textContent).toContain("Owner-Timer (1.1.0)");
  expect(host.textContent).toContain("shared.nrm");
  expect([...host.querySelectorAll("button")].some((b) => b.textContent === "Install")).toBe(false);

  await act(async () => button(host, "Allow its code and install").click());
  expect(applied).toHaveBeenCalledWith(
    "zelda64-recomp",
    "default",
    codePlan.plan_sha256,
    codePlan,
    7,
    true,
  );
});

it("filters the current page and shows attributed, individually identified file variants", async () => {
  const listing = browse();
  const details = project();
  details.project.submitter = "Artist";
  details.project.profile_url = "https://gamebanana.com/mods/42";
  const current = details.project.files[0];
  if (!current) throw new Error("The fixture must have a current file.");
  details.project.files.push({
    ...current,
    file_id: "8",
    file_name: "old.zip",
    archived: true,
  });
  vi.spyOn(desktopApi, "browseProviderMods").mockResolvedValue(listing);
  vi.spyOn(desktopApi, "providerProject").mockResolvedValue(details);
  const openProject = vi.spyOn(desktopApi, "openProviderModProject").mockResolvedValue(undefined);
  const { host } = await render();
  await act(async () => button(host, "Find mods on GameBanana…").click());
  const filter = page.getByRole("searchbox", {
    name: "Filter this page by name, version, or submitter",
  });
  await filter.fill("unknown");
  await expect.element(page.getByText("No matches on this page.")).toBeVisible();
  await filter.fill("2.0");
  await page.getByRole("button", { name: "Show files of HD Link" }).click();
  await expect.element(page.getByText("Submitted by Artist")).toBeVisible();
  const link = page.getByRole("link", { name: "Open project on GameBanana" });
  await expect.element(link).toHaveAttribute("href", "https://gamebanana.com/mods/42");
  await link.click();
  expect(openProject).toHaveBeenCalledWith("shipwright", "42", 7, "gamebanana");
  await expect.element(page.getByText("old.zip", { exact: true })).not.toBeInTheDocument();
  await page.getByRole("checkbox", { name: "Show archived files" }).click();
  await expect.element(page.getByText("old.zip", { exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: /Review old[.]zip/ }))
    .not.toBeInTheDocument();
});

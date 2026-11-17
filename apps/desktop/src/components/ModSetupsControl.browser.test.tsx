import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { desktopApi } from "../api";
import * as picker from "../file-picker";
import type { ModFilePreservationPlan, ModSetupOriginalReview, ModSetupsView } from "../types";
import { sourceProfile } from "../test-fixtures";
import { ModSetupsControl } from "./ModSetupsControl";
import "../styles/index.css";

vi.mock("../file-picker", { spy: true });

const mounted: { root: Root; host: HTMLElement }[] = [];
afterEach(async () => {
  for (const { root, host } of mounted.splice(0)) {
    await act(async () => root.unmount());
    host.remove();
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setup(id: string, name: string, revision: number, packages: [string, boolean][]) {
  return {
    originals: [],
    profile: {
      id,
      port_id: "shipwright",
      display_name: name,
      is_default: id === "default",
      current_revision: revision,
    },
    revision: {
      profile_id: id,
      revision,
      packages: packages.map(([native_id, enabled]) => ({
        native_id,
        enabled,
        sha256: "a".repeat(64),
        size: 1,
      })),
      // The last package wins; the list shows that priority order.
      orderings: [{ domain: "asset-override", native_ids: packages.map(([id]) => id).reverse() }],
    },
  };
}

function view(overrides: Partial<ModSetupsView> = {}): ModSetupsView {
  return {
    port_id: "shipwright",
    supported: true,
    package_types: ["o2r", "otr"],
    later_mods_take_priority: true,
    held_updates: [],
    provider: null,
    inventory: {
      port_id: "shipwright",
      profiles: [
        setup("default", "Default", 3, [
          ["hd.o2r", true],
          ["sfx.otr", false],
        ]),
        setup("clean", "Clean", 1, []),
      ],
    },
    live: {
      profile_id: "default",
      revision: 3,
      unmanaged: [],
      changed_owned: [],
      native_list: { state: "in-sync" },
    },
    ...overrides,
  } as unknown as ModSetupsView;
}

async function render(busy = false) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () =>
    root.render(<ModSetupsControl portId="shipwright" generation={7} busy={busy} />),
  );
  return host;
}

function button(host: HTMLElement, label: string) {
  const found = [...host.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`missing button ${label}`);
  return found;
}

it("renders nothing for a game without reviewed mod support", async () => {
  vi.spyOn(desktopApi, "modSetups").mockResolvedValue(
    view({ supported: false, inventory: null, live: null }),
  );
  const host = await render();
  expect(host.textContent).toBe("");
});

it("lists setups and mods in priority order and binds changes to the reviewed revision", async () => {
  const read = vi.spyOn(desktopApi, "modSetups").mockResolvedValue(view());
  const toggle = vi
    .spyOn(desktopApi, "setModPackageEnabled")
    .mockResolvedValue({} as Awaited<ReturnType<typeof desktopApi.setModPackageEnabled>>);
  const use = vi
    .spyOn(desktopApi, "useModSetup")
    .mockResolvedValue({} as Awaited<ReturnType<typeof desktopApi.useModSetup>>);
  const host = await render();
  expect(read).toHaveBeenCalledWith("shipwright", 7);
  expect(host.textContent).toContain("In use");
  const labels = [...host.querySelectorAll("label")].map((label) => label.textContent);
  expect(labels.indexOf("sfx.otr")).toBeLessThan(labels.indexOf("hd.o2r"));

  const hd = [...host.querySelectorAll("label")].find((label) => label.textContent === "hd.o2r");
  const box = hd?.querySelector("[role=checkbox]");
  if (!(box instanceof HTMLElement)) throw new Error("missing hd.o2r checkbox");
  await act(async () => box.click());
  expect(toggle).toHaveBeenCalledWith("shipwright", "default", "hd.o2r", false, 3, 7);
  expect(host.querySelector("[role=status]")?.textContent).toContain("Turned off hd.o2r");

  await act(async () => button(host, "Use Clean").click());
  expect(use).toHaveBeenCalledWith("shipwright", "clean", 7);
  expect(read).toHaveBeenCalledTimes(3);
});

it("states priority only for loaders where it is established", async () => {
  vi.spyOn(desktopApi, "modSetups").mockResolvedValue(
    view({ package_types: ["nrm"], later_mods_take_priority: false }),
  );
  const host = await render();
  expect(host.textContent).toContain("The game loads mods in this order.");
  expect(host.textContent).not.toContain("take priority");
});

it("explains held changes and Core refusals without claiming success", async () => {
  vi.spyOn(desktopApi, "modSetups").mockResolvedValue(
    view({
      live: {
        profile_id: "default",
        revision: 3,
        unmanaged: ["mine.o2r"],
        changed_owned: [],
        native_list: { state: "differs", missing: ["hd"], unexpected: [] },
      },
    }),
  );
  const host = await render();
  expect(host.textContent).toContain("files this setup did not add");
  expect(host.textContent).toContain("mine.o2r");
  expect(host.textContent).toContain("Review the enabled mods and their dependencies");
  expect(button(host, "Use Clean").disabled).toBe(true);
  expect(button(host, "Add mod file…").disabled).toBe(true);
});

it("offers the first setup and reports a refused change as an alert", async () => {
  vi.spyOn(desktopApi, "modSetups").mockResolvedValue(view({ inventory: null, live: null }));
  const create = vi
    .spyOn(desktopApi, "createDefaultModSetup")
    .mockRejectedValue(new Error("the port has no active installation to migrate"));
  const host = await render();
  expect(host.textContent).toContain("has no setup yet");
  await act(async () => button(host, "Create first setup").click());
  expect(create).toHaveBeenCalledWith("shipwright", 7);
  expect(host.querySelector("[role=alert]")?.textContent).toContain("no active installation");
  expect(host.querySelector("[role=status]")).toBeNull();
});

it("waits for the current operation before reading and shows nothing until support is known", async () => {
  const read = vi.spyOn(desktopApi, "modSetups");
  const host = await render(true);
  expect(read).not.toHaveBeenCalled();
  expect(host.textContent).toBe("");
});

it("keeps controls disabled until the view is read again after a change", async () => {
  let release: (() => void) | undefined;
  const read = vi
    .spyOn(desktopApi, "modSetups")
    .mockResolvedValueOnce(view())
    .mockImplementation(() => new Promise((resolve) => (release = () => resolve(view()))));
  vi.spyOn(desktopApi, "useModSetup").mockResolvedValue(
    {} as Awaited<ReturnType<typeof desktopApi.useModSetup>>,
  );
  const host = await render();
  await act(async () => button(host, "Use Clean").click());
  expect(read).toHaveBeenCalledTimes(2);
  expect(button(host, "Use Clean").disabled).toBe(true);
  await act(async () => release?.());
  expect(button(host, "Use Clean").disabled).toBe(false);
});

it("offers to read again when the view cannot be refreshed after a change", async () => {
  const read = vi
    .spyOn(desktopApi, "modSetups")
    .mockResolvedValueOnce(view())
    .mockRejectedValueOnce(new Error("controlled read failure"))
    .mockResolvedValue(view());
  vi.spyOn(desktopApi, "useModSetup").mockResolvedValue(
    {} as Awaited<ReturnType<typeof desktopApi.useModSetup>>,
  );
  const host = await render();
  await act(async () => button(host, "Use Clean").click());
  expect(host.querySelector("[role=alert]")?.textContent).toContain("controlled read failure");
  expect(button(host, "Use Clean").disabled).toBe(true);
  await act(async () => button(host, "Read setups again").click());
  expect(read).toHaveBeenCalledTimes(3);
  expect(button(host, "Use Clean").disabled).toBe(false);
});

it("explains a held unattended update for the setup in use", async () => {
  vi.spyOn(desktopApi, "modSetups").mockResolvedValue(
    view({
      provider: "gamebanana",
      held_updates: [
        {
          profile_id: "default",
          native_ids: ["hd.o2r"],
          project_id: "42",
          candidate_file_id: "11",
          reason: "the newer file changes which mods it contains",
        },
        {
          profile_id: "clean",
          native_ids: ["other.o2r"],
          project_id: "43",
          candidate_file_id: "12",
          reason: "not for the setup in use",
        },
      ],
    }),
  );
  const host = await render();
  expect(host.textContent).toContain(
    "kept the current version of a mod because its update needs your review",
  );
  expect(host.textContent).toContain("checks again when this setup changes");
  expect(host.textContent).toContain("Find mods on GameBanana below");
  expect(host.textContent).toContain("hd.o2r: the newer file changes which mods it contains");
  expect(host.textContent).not.toContain("not for the setup in use");
});

it("words several held updates together and shows none without a setup in use", async () => {
  const held = (native_ids: string[], candidate_file_id: string) => ({
    profile_id: "default",
    native_ids,
    project_id: "42",
    candidate_file_id,
    reason: "the update changes which mod wins an asset another enabled mod also changes",
  });
  vi.spyOn(desktopApi, "modSetups")
    .mockResolvedValueOnce(
      view({ held_updates: [held(["a.o2r", "b.o2r"], "11"), held(["c.o2r"], "12")] }),
    )
    .mockResolvedValueOnce(view({ live: null, held_updates: [held(["a.o2r"], "11")] }));
  const host = await render();
  expect(host.textContent).toContain("current versions of some mods because their updates");
  expect(host.textContent).toContain("a.o2r, b.o2r:");
  const notice = host.querySelector("[data-slot=notice] ul");
  expect(notice?.querySelectorAll("li").length).toBe(2);

  const other = await render();
  expect(other.textContent).not.toContain("needs your review");
});

it("offers GameBanana only for a game with a reviewed binding", async () => {
  vi.spyOn(desktopApi, "modSetups")
    .mockResolvedValueOnce(view())
    .mockResolvedValueOnce(view({ provider: "gamebanana" }));
  const without = await render();
  expect(without.textContent).not.toContain("Find mods on GameBanana");
  const bound = await render();
  expect(button(bound, "Find mods on GameBanana…").disabled).toBe(false);
});

it("presents setups, counts and the reordered list in the active locale", async () => {
  const { initializeLocalization } = await import("../localization");
  const localization = initializeLocalization(["en-US"]);
  try {
    await localization.changeLanguage("ar-XB");
    const base = view();
    vi.spyOn(desktopApi, "modSetups").mockResolvedValue(
      view({
        live: {
          ...base.live!,
          native_list: { state: "reordered", native_order: ["sfx.otr", "hd.o2r"] },
        },
      }),
    );
    const host = await render();
    expect(host.querySelector("h3")?.textContent).toBe("ملفات التعريف والتعديلات");
    expect(host.querySelector("ul")?.getAttribute("aria-label")).toBe("ملفات التعريف");
    expect(host.textContent).toContain("تعديل واحد مُشغّل");
    expect(host.textContent).toContain("لا توجد تعديلات مُشغّلة");
    expect(host.textContent).toContain("قيد الاستخدام");
    expect(host.textContent).toContain("أعدت ترتيب التعديلات في اللعبة (sfx.otr، hd.o2r).");
    expect(host.querySelector("h4")?.textContent).toBe("التعديلات في Default");
    expect(button(host, "استخدام Clean")).toBeTruthy();
  } finally {
    await localization.changeLanguage("en");
  }
});

it("isolates mod identifiers and uses plural forms in the active locale", async () => {
  const { initializeLocalization } = await import("../localization");
  const localization = initializeLocalization(["en-US"]);
  try {
    await localization.changeLanguage("ar-XB");
    const base = view();
    const many = setup("many", "Many", 1, [
      ["a.o2r", true],
      ["b.o2r", true],
      ["c.o2r", true],
    ]);
    const two = setup("two", "Two", 1, [
      ["a.o2r", true],
      ["b.o2r", true],
    ]);
    const first = base.inventory!.profiles[0]!;
    const provided = {
      ...first,
      revision: {
        ...first.revision,
        packages: first.revision.packages!.map((item, index) =>
          index === 0 ? { ...item, provider: { provider: "gamebanana" } } : item,
        ),
      },
    };
    vi.spyOn(desktopApi, "modSetups").mockResolvedValue(
      view({
        inventory: {
          ...base.inventory!,
          profiles: [provided, two, many],
        },
      } as Partial<ModSetupsView>),
    );
    const host = await render();
    expect(host.textContent).toContain("تعديلان مُشغّلان");
    expect(host.textContent).toContain("3 تعديلات مُشغّلة");
    const label = [...host.querySelectorAll("label")].find((item) =>
      item.textContent?.includes("gamebanana"),
    );
    expect(label?.textContent).toBe("hd.o2r (من gamebanana)");
    expect([...(label?.querySelectorAll("bdi") ?? [])].map((item) => item.textContent)).toEqual([
      "hd.o2r",
      "gamebanana",
    ]);
  } finally {
    await localization.changeLanguage("en");
  }
});

it("translates the game-changed mismatch while keeping Core failures verbatim", async () => {
  const { initializeLocalization } = await import("../localization");
  const localization = initializeLocalization(["en-US"]);
  try {
    await localization.changeLanguage("ar-XB");
    vi.spyOn(desktopApi, "modSetups").mockResolvedValue(view({ port_id: "other" }));
    const host = await render();
    expect(host.querySelector("[role=alert]")?.textContent).toBe(
      "تغيّرت هذه اللعبة. حدّث تفاصيلها قبل تغيير التعديلات.",
    );
    expect(button(host, "قراءة ملفات التعريف مرة أخرى")).toBeTruthy();
  } finally {
    await localization.changeLanguage("en");
  }
});

it("words held updates with the locale's plural forms", async () => {
  const { initializeLocalization } = await import("../localization");
  const localization = initializeLocalization(["en-US"]);
  try {
    await localization.changeLanguage("ar-XB");
    const held = (candidate_file_id: string) => ({
      profile_id: "default",
      native_ids: ["hd.o2r"],
      project_id: "42",
      candidate_file_id,
      reason: "the newer file changes which mods it contains",
    });
    vi.spyOn(desktopApi, "modSetups").mockResolvedValue(
      view({ provider: "gamebanana", held_updates: [held("11"), held("12")] }),
    );
    const host = await render();
    expect(host.textContent).toContain("أبقى Portcove الإصدارين الحاليين");
    expect(host.textContent).toContain("the newer file changes which mods it contains");
    expect(host.textContent).toContain("ابحث عن كل تعديل باستخدام «ابحث عن تعديلات في GameBanana»");
  } finally {
    await localization.changeLanguage("en");
  }
});

it("refreshes a Default setup whose recorded runtime predates the active game", async () => {
  const base = view();
  const [defaultView, ...other] = base.inventory!.profiles;
  if (!defaultView) throw new Error("missing Default setup fixture");
  const withDefault = (install_id: string) =>
    view({
      current_install_id: "current",
      inventory: {
        ...base.inventory!,
        profiles: [
          { ...defaultView, revision: { ...defaultView.revision, build: { install_id } } },
          ...other,
        ],
      },
    } as unknown as Partial<ModSetupsView>);
  vi.spyOn(desktopApi, "modSetups")
    .mockResolvedValueOnce(withDefault("previous"))
    .mockResolvedValue(withDefault("current"));
  const repair = vi
    .spyOn(desktopApi, "createDefaultModSetup")
    .mockResolvedValue(defaultView.profile);
  await render();
  const update = page.getByRole("button", { name: "Refresh Default setup" });
  await expect.element(update).toBeVisible();
  await update.click();
  expect(repair).toHaveBeenCalledWith("shipwright", 7);
  await expect.element(update).not.toBeInTheDocument();
});

it("offers a copy on the current version only for a customized setup on another version", async () => {
  const onBuild = (entry: ReturnType<typeof setup>, install_id: string) => ({
    ...entry,
    revision: { ...entry.revision, build: { install_id }, digest: "a".repeat(64) },
  });
  const customized = view({
    current_install_id: "v2",
    progress_copy_supported: true,
    inventory: {
      port_id: "shipwright",
      profiles: [
        onBuild(setup("default", "Default", 3, [["hd.o2r", true]]), "v1"),
        onBuild(setup("custom", "Custom", 2, [["hd.o2r", true]]), "v1"),
      ],
    },
    live: {
      profile_id: "custom",
      revision: 2,
      unmanaged: [],
      changed_owned: [],
      native_list: { state: "in-sync" },
    },
  } as unknown as Partial<ModSetupsView>);
  const read = vi.spyOn(desktopApi, "modSetups").mockResolvedValue(customized);
  const copy = vi
    .spyOn(desktopApi, "copyModSetup")
    .mockResolvedValue({} as Awaited<ReturnType<typeof desktopApi.copyModSetup>>);
  const host = await render();
  expect(host.textContent).toContain("stays on the game version it was made with");
  await page.getByRole("textbox", { name: "New setup name" }).fill("Custom updated");
  await act(async () => button(host, "Copy onto the current version").click());
  expect(copy).toHaveBeenCalledWith("shipwright", "custom", "Custom updated", 7, true, undefined);
  expect(host.querySelector("[role=status]")?.textContent).toContain(
    "Created Custom updated on the game’s current version",
  );

  await page.getByRole("checkbox", { name: "Copy supported saves" }).click();
  await page.getByRole("textbox", { name: "New setup name" }).fill("Custom with saves");
  await act(async () => button(host, "Copy onto the current version").click());
  expect(copy).toHaveBeenLastCalledWith("shipwright", "custom", "Custom with saves", 7, true, {
    source_revision_sha256: "a".repeat(64),
    target_install_id: "v2",
    target_revision_sha256: "a".repeat(64),
  });
  await expect
    .element(page.getByRole("checkbox", { name: "Copy supported saves" }))
    .not.toBeChecked();

  // The default setup follows updates, and a setup already on the current
  // version needs no upgraded copy.
  for (const live of ["default", "custom"]) {
    read.mockResolvedValue({
      ...customized,
      current_install_id: live === "custom" ? "v1" : "v2",
      live: { ...customized.live!, profile_id: live },
    });
    const again = await render();
    expect(again.textContent).not.toContain("stays on the game version");
    expect(
      [...again.querySelectorAll("button")].some(
        (candidate) => candidate.textContent === "Copy onto the current version",
      ),
    ).toBe(false);
  }
});

const localPlan: Awaited<ReturnType<typeof desktopApi.planLocalModPackage>> = {
  profile_id: "default",
  expected_revision: 3,
  native_id: "speedrun_timer.nrm",
  sha256: "b".repeat(64),
  size: 4096,
  asset_count: 0,
  replaces: [],
  replaces_enabled: true,
  overlapping_mods: [],
  conflicts_truncated: false,
  required_mods: [],
  missing_required_mods: [],
  needs_code_permission: true,
  plan_sha256: "c".repeat(64),
};

it("asks before adding a mod that runs code and binds the choice to the reviewed file", async () => {
  vi.spyOn(desktopApi, "modSetups").mockResolvedValue(view({ package_types: ["nrm"] }));
  vi.mocked(picker.pickModPackagePath).mockResolvedValue("/mods/timer.nrm");
  const review = vi.spyOn(desktopApi, "planLocalModPackage").mockResolvedValue(localPlan);
  const add = vi
    .spyOn(desktopApi, "applyLocalModPackage")
    .mockResolvedValue({} as Awaited<ReturnType<typeof desktopApi.applyLocalModPackage>>);
  const host = await render();
  await act(async () => button(host, "Add mod file…").click());
  expect(review).toHaveBeenCalledWith("shipwright", "default", "/mods/timer.nrm", 3, 7);
  expect(add).not.toHaveBeenCalled();
  expect(host.textContent).toContain("This exact mod runs its own code inside the game");
  expect(host.textContent).toContain("speedrun_timer.nrm");
  expect([...host.querySelectorAll("code[dir=ltr]")].map((code) => code.textContent)).toContain(
    "b".repeat(64),
  );

  await act(async () => button(host, "Don’t add").click());
  expect(add).not.toHaveBeenCalled();

  await act(async () => button(host, "Add mod file…").click());
  await act(async () => button(host, "Allow its code and add").click());
  expect(add).toHaveBeenCalledWith(
    "shipwright",
    "default",
    "/mods/timer.nrm",
    "c".repeat(64),
    7,
    true,
  );
});

it("reviews a disabled replacement before adding a local file", async () => {
  vi.spyOn(desktopApi, "modSetups").mockResolvedValue(view());
  vi.mocked(picker.pickModPackagePath).mockResolvedValue("/mods/ui.o2r");
  vi.spyOn(desktopApi, "planLocalModPackage").mockResolvedValue({
    ...localPlan,
    native_id: "ui.o2r",
    asset_count: 4,
    overlapping_mods: [],
    replaces: ["ui.otr"],
    replaces_enabled: false,
    needs_code_permission: false,
  });
  const add = vi
    .spyOn(desktopApi, "applyLocalModPackage")
    .mockResolvedValue({} as Awaited<ReturnType<typeof desktopApi.applyLocalModPackage>>);
  const host = await render();
  await act(async () => button(host, "Add mod file…").click());
  expect(host.textContent).toContain("The replacement stays off.");
  expect(host.textContent).toContain("Replaces ui.otr");
  expect(add).not.toHaveBeenCalled();
  await act(async () => button(host, "Add reviewed file").click());
  expect(add).toHaveBeenCalledWith(
    "shipwright",
    "default",
    "/mods/ui.o2r",
    "c".repeat(64),
    7,
    false,
  );
});

it("points held Thunderstore updates to the Thunderstore browser", async () => {
  vi.spyOn(desktopApi, "modSetups").mockResolvedValue(
    view({
      provider: "thunderstore",
      held_updates: [
        {
          profile_id: "default",
          native_ids: ["hd.o2r"],
          project_id: "Owner-Timer",
          candidate_file_id: "1.1.0",
          reason: "the update runs its own code inside the game; review it to allow that code",
        },
      ],
    }),
  );
  const host = await render();
  expect(host.textContent).toContain("Find mods on Thunderstore below");
  expect(host.textContent).not.toContain("GameBanana");
  expect(
    [...host.querySelectorAll("button")].some(
      (candidate) => candidate.textContent?.trim() === "Find mods on Thunderstore…",
    ),
  ).toBe(true);
});

it("reviews removal before sending the exact setup revision to Core", async () => {
  vi.spyOn(desktopApi, "modSetups").mockResolvedValue(view());
  const request = vi
    .spyOn(desktopApi, "removeModPackage")
    .mockResolvedValue({} as Awaited<ReturnType<typeof desktopApi.removeModPackage>>);
  await render();
  const remove = page.getByRole("button", { name: "Remove hd.o2r from this setup" });
  await remove.click();
  await expect
    .element(page.getByText("Earlier revisions keep this mod for recovery."))
    .toBeVisible();
  expect(request).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(request).not.toHaveBeenCalled();
  await expect.element(remove).toHaveFocus();

  await remove.click();
  await page.getByRole("button", { name: "Confirm removal" }).click();
  expect(request).toHaveBeenCalledWith("shipwright", "default", "hd.o2r", 3, 7);
  await expect.element(page.getByText("Removed hd.o2r from this setup.")).toBeVisible();
});

it("shows the exact runtime and offers a direct switch to clean play", async () => {
  const data = view();
  const { inventory, live } = data;
  const [defaultSetup, customized] = inventory?.profiles ?? [];
  const mod = defaultSetup?.revision.packages?.find(({ native_id }) => native_id === "hd.o2r");
  if (!inventory || !live || !defaultSetup || !customized || !mod)
    throw new Error("The fixture must have a live setup and two setup revisions.");
  inventory.profiles = [
    {
      ...defaultSetup,
      build_version: "9.3.1",
      build_availability: "verified",
      revision: { ...defaultSetup.revision, packages: [], orderings: [] },
    },
    {
      ...customized,
      build_version: "9.3.0",
      build_availability: "held",
      profile: { ...customized.profile, display_name: "Customized" },
      revision: {
        ...customized.revision,
        packages: [mod],
        orderings: [{ domain: "asset-override", native_ids: [mod.native_id] }],
      },
    },
  ];
  live.profile_id = customized.profile.id;
  live.revision = customized.profile.current_revision;
  vi.spyOn(desktopApi, "modSetups").mockResolvedValue(data);
  const use = vi
    .spyOn(desktopApi, "useModSetup")
    .mockResolvedValue({} as Awaited<ReturnType<typeof desktopApi.useModSetup>>);
  await render();
  await expect.element(page.getByText("Game version 9.3.1")).toBeVisible();
  await expect.element(page.getByText("Game version 9.3.0")).toBeVisible();
  await expect.element(page.getByText("This setup’s runtime needs attention.")).toBeVisible();
  await page.getByRole("button", { name: "Switch to clean play" }).click();
  expect(use).toHaveBeenCalledWith("shipwright", "default", 7);
});

it("keeps setup changes disabled during a file picker and leaves a dismissed picker alone", async () => {
  vi.spyOn(desktopApi, "modSetups").mockResolvedValue(view());
  let closePicker: (value: null) => void = () => {};
  vi.mocked(picker.pickModPackagePath).mockImplementation(
    () =>
      new Promise((resolve) => {
        closePicker = resolve;
      }),
  );
  const review = vi.spyOn(desktopApi, "planLocalModPackage");
  const host = await render();
  await act(async () => button(host, "Add mod file…").click());
  expect(button(host, "Use Clean").disabled).toBe(true);
  expect(button(host, "Open setup recipe…").disabled).toBe(true);
  await act(async () => closePicker(null));
  expect(button(host, "Use Clean").disabled).toBe(false);
  expect(button(host, "Open setup recipe…").disabled).toBe(false);
  expect(review).not.toHaveBeenCalled();
});

it("leaves the recipe review unchanged when the picker is cancelled", async () => {
  vi.spyOn(desktopApi, "modSetups").mockResolvedValue(view());
  vi.spyOn(picker, "pickModRecipePath").mockResolvedValue(null);
  const inspect = vi.spyOn(desktopApi, "inspectModRecipe");
  await render();
  await page.getByRole("button", { name: "Open setup recipe…" }).click();
  expect(inspect).not.toHaveBeenCalled();
  await expect
    .element(page.getByRole("heading", { name: "Recipe review" }))
    .not.toBeInTheDocument();
});

it("opens an exact recipe review and creates a separately named setup", async () => {
  vi.spyOn(desktopApi, "modSetups").mockResolvedValue(view());
  vi.spyOn(picker, "pickModRecipePath").mockResolvedValue("/picked/setup.json");
  const plan = {
    can_apply: true,
    holds: [],
    originals: [],
    packages: [],
    plan_sha256: "a".repeat(64),
    recipe: {
      identity_sha256: "a".repeat(64),
      uncaptured: [],
      packages: [],
      orderings: [],
      runtime: { platform: "windows-x86-64" },
    },
    runtime: { name: "runtime", status: "available", detail: "The exact runtime is installed." },
  } as unknown as Awaited<ReturnType<typeof desktopApi.inspectModRecipe>>;
  const inspect = vi.spyOn(desktopApi, "inspectModRecipe").mockResolvedValue(plan);
  const apply = vi
    .spyOn(desktopApi, "applyModRecipe")
    .mockResolvedValue({} as Awaited<ReturnType<typeof desktopApi.applyModRecipe>>);
  await render();
  await page.getByRole("button", { name: "Open setup recipe…" }).click();
  await expect.element(page.getByRole("heading", { name: "Recipe review" })).toHaveFocus();
  expect(inspect).toHaveBeenCalledWith("shipwright", "/picked/setup.json", 7);
  const create = page.getByRole("button", { name: "Create setup from recipe" });
  await expect.element(create).toBeDisabled();
  await page.getByRole("textbox", { name: "Name for the new setup" }).fill("Shared setup");
  await create.click();
  expect(apply).toHaveBeenCalledWith("shipwright", "Shared setup", plan, 7);
  await expect.element(page.getByText("Created Shared setup with fresh progress.")).toBeVisible();
});

it("shows exact missing recipe inputs before any import is offered", async () => {
  vi.spyOn(desktopApi, "modSetups").mockResolvedValue(view());
  vi.spyOn(picker, "pickModRecipePath").mockResolvedValue("/picked/setup.json");
  const plan = {
    can_apply: false,
    holds: ["Review the exact required provider version."],
    originals: [],
    packages: [{ name: "retro.o2r", status: "unavailable", detail: "Review project 1, file 2." }],
    recipe: {
      identity_sha256: "a".repeat(64),
      uncaptured: [],
      packages: [],
      orderings: [],
      runtime: { platform: "windows-x86-64" },
    },
    runtime: { name: "runtime", status: "available", detail: "The exact runtime is installed." },
  } as unknown as Awaited<ReturnType<typeof desktopApi.inspectModRecipe>>;
  vi.spyOn(desktopApi, "inspectModRecipe").mockResolvedValue(plan);
  await render();
  const open = page.getByRole("button", { name: "Open setup recipe…" });
  await open.click();
  await expect.element(page.getByText("Review the exact required provider version.")).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Create setup from recipe" }))
    .not.toBeInTheDocument();
  await page.getByRole("button", { name: "Close review" }).click();
  await expect.element(open).toHaveFocus();
});

const originalBinding = {
  requirement_id: "sample-rom",
  sha256: "a".repeat(64),
  size: 64,
  storage_sha256: "b".repeat(64),
  storage_size: 64,
};
const originalTarget = {
  portId: "shipwright",
  profileId: "clean",
  expectedRevision: 1,
  requirementId: "sample-rom",
  generation: 7,
};
const alternativeInstanceId = "e".repeat(64);
const originalReview: ModSetupOriginalReview = {
  source_profile: { ...sourceProfile(), id: "sample-rom" },
  current_instance_id: "d".repeat(64),
  current_path: "D:/Old/recorded.z64",
  embedded: false,
  instances: [
    {
      instance_id: alternativeInstanceId,
      binding: { ...originalBinding, sha256: "c".repeat(64) },
      path: "D:/Other/original.z64",
    },
  ],
};

function selectedOriginalView(revision = 1) {
  const inventory = view().inventory;
  const clean = inventory?.profiles.find(({ profile }) => profile.id === "clean");
  if (!inventory || !clean) throw new Error("missing customized setup fixture");
  clean.originals = [{ binding: originalBinding, availability: "missing" }];
  clean.profile.current_revision = revision;
  clean.revision.revision = revision;
  return view({
    inventory,
    live: {
      profile_id: "clean",
      revision,
      unmanaged: [],
      changed_owned: [],
      native_list: { state: "in-sync" },
    },
  });
}

it("shows the saved original hold and selects an exact registered alternative", async () => {
  const reread = vi.spyOn(desktopApi, "modSetups").mockResolvedValue(selectedOriginalView());
  const review = vi.spyOn(desktopApi, "reviewModSetupOriginal").mockResolvedValue(originalReview);
  const select = vi.spyOn(desktopApi, "selectModSetupOriginal").mockResolvedValue(undefined);
  vi.mocked(picker.pickModPackagePath).mockResolvedValue("/mods/ui.o2r");
  vi.spyOn(desktopApi, "planLocalModPackage").mockResolvedValue({
    ...localPlan,
    profile_id: "clean",
    expected_revision: 1,
  });
  const host = await render();
  expect(host.textContent).toContain("The file this setup recorded is missing.");

  const reviewOriginal = button(host, "Review original game files");
  await act(async () => button(host, "Add mod file…").click());
  expect(reviewOriginal.disabled).toBe(true);
  await act(async () => button(host, "Don’t add").click());
  expect(reviewOriginal.disabled).toBe(false);
  await act(async () => reviewOriginal.click());
  expect(review).toHaveBeenCalledWith(originalTarget);
  expect(host.textContent).toContain("D:/Old/recorded.z64");
  expect(button(host, "Use this original").disabled).toBe(true);
  await act(async () =>
    page.getByRole("combobox", { name: /^Other registered originals/ }).click(),
  );
  await act(async () => page.getByRole("option", { name: "D:/Other/original.z64" }).click());
  await act(async () => button(host, "Use this original").click());

  expect(select).toHaveBeenCalledWith(originalTarget, alternativeInstanceId);
  expect(reread).toHaveBeenCalledTimes(2);
});

it("keeps the exact original and action focus through a transient refusal and retry", async () => {
  let rejectSelect!: (failure: Error) => void;
  const pending = new Promise<undefined>((_, reject) => {
    rejectSelect = reject;
  });
  let resolveRetry!: (value: undefined) => void;
  const retry = new Promise<undefined>((resolve) => {
    resolveRetry = resolve;
  });
  vi.spyOn(desktopApi, "modSetups").mockResolvedValue(selectedOriginalView());
  vi.spyOn(desktopApi, "reviewModSetupOriginal").mockResolvedValue(originalReview);
  const select = vi
    .spyOn(desktopApi, "selectModSetupOriginal")
    .mockReturnValueOnce(pending)
    .mockReturnValueOnce(retry);
  const host = await render();
  const choose = page.getByRole("combobox", { name: /^Other registered originals/ });
  const use = page.getByRole("button", { name: "Use this original" });

  await act(async () => button(host, "Review original game files").click());
  await act(async () => choose.click());
  await act(async () => page.getByRole("option", { name: "D:/Other/original.z64" }).click());
  await act(async () => use.click());
  await expect.element(use).toHaveAttribute("aria-disabled", "true");
  await expect.element(use).toHaveFocus();

  await act(async () =>
    rejectSelect(new Error("The selected original is temporarily unavailable.")),
  );
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("The selected original is temporarily unavailable.");
  await expect
    .element(choose)
    .toHaveAccessibleName("Other registered originals D:/Other/original.z64");
  await expect.element(use).toHaveFocus();
  await expect.element(use).toBeEnabled();
  await act(async () => use.click());
  await act(async () => userEvent.tab());
  await expect.element(page.getByRole("button", { name: "Find the same original" })).toHaveFocus();
  await act(async () => resolveRetry(undefined));

  expect(select.mock.calls).toEqual([
    [originalTarget, alternativeInstanceId],
    [originalTarget, alternativeInstanceId],
  ]);
  await expect.element(choose).not.toBeInTheDocument();
  await expect.element(page.getByRole("heading", { name: "Setups and mods" })).toHaveFocus();
});

it("requires another original review when the setup revision changes after a refusal", async () => {
  vi.spyOn(desktopApi, "modSetups")
    .mockResolvedValueOnce(selectedOriginalView())
    .mockResolvedValue(selectedOriginalView(2));
  const review = vi.spyOn(desktopApi, "reviewModSetupOriginal").mockResolvedValue(originalReview);
  const select = vi
    .spyOn(desktopApi, "selectModSetupOriginal")
    .mockRejectedValueOnce(new Error("This setup changed."));
  const host = await render();
  const choose = page.getByRole("combobox", { name: /^Other registered originals/ });

  await act(async () => button(host, "Review original game files").click());
  await act(async () => choose.click());
  await act(async () => page.getByRole("option", { name: "D:/Other/original.z64" }).click());
  await act(async () => page.getByRole("button", { name: "Use this original" }).click());
  await expect.element(choose).not.toBeInTheDocument();
  await expect.element(page.getByRole("heading", { name: "Setups and mods" })).toHaveFocus();
  await act(async () => button(host, "Review original game files").click());

  expect(select).toHaveBeenCalledExactlyOnceWith(originalTarget, alternativeInstanceId);
  expect(review.mock.calls).toEqual([
    [originalTarget],
    [{ ...originalTarget, expectedRevision: 2 }],
  ]);
  expect(button(host, "Use this original").disabled).toBe(true);
});

it("offers verified relinking for the recorded original of an already prepared installation", async () => {
  vi.spyOn(desktopApi, "modSetups").mockResolvedValue(selectedOriginalView());
  vi.spyOn(desktopApi, "reviewModSetupOriginal").mockResolvedValue({
    ...originalReview,
    embedded: true,
    instances: [],
  });
  const pick = vi.spyOn(picker, "pickSourcePath").mockResolvedValue("D:/Moved/recorded.z64");
  const relink = vi
    .spyOn(desktopApi, "relinkModSetupOriginal")
    .mockRejectedValueOnce(new Error("That location is temporarily unavailable."))
    .mockResolvedValueOnce(undefined);
  const host = await render();
  const find = page.getByRole("button", { name: "Find the same original" });

  await act(async () => button(host, "Review original game files").click());
  expect(host.textContent).toContain("This installation uses game data it already prepared.");
  expect(host.querySelector('[role="combobox"]')).toBeNull();
  await act(async () => find.click());
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("That location is temporarily unavailable.");
  await expect.element(find).toHaveFocus();
  expect(host.textContent).toContain("D:/Old/recorded.z64");
  await act(async () => find.click());

  expect(pick).toHaveBeenCalledWith(
    originalReview.source_profile,
    originalReview.current_path,
    "game",
  );
  expect(relink.mock.calls).toEqual([
    [originalTarget, "D:/Moved/recorded.z64"],
    [originalTarget, "D:/Moved/recorded.z64"],
  ]);
  await expect.element(find).not.toBeInTheDocument();
  await expect.element(page.getByRole("heading", { name: "Setups and mods" })).toHaveFocus();
});

it("reviews an earlier setup, keeps progress, and applies only the eligible exact review", async () => {
  const read = vi.spyOn(desktopApi, "modSetups").mockResolvedValue(view());
  const revision = (number: number, asset: string, enabled: boolean) =>
    ({
      ...setup("default", "Default", number, [["hd.o2r", enabled]]).revision,
      build: { port_id: "shipwright", artifact: { asset_name: asset } },
    }) as Awaited<ReturnType<typeof desktopApi.modSetupRevisions>>[number];
  const current = revision(3, "Shipwright 9.4", true);
  const target = revision(2, "Shipwright 9.3", false);
  const history = vi.spyOn(desktopApi, "modSetupRevisions").mockResolvedValue([target, current]);
  const reviewed = {
    current,
    target,
    selected_revision: 3,
    progress: "keep_current",
    update_policy: "review_updates",
    originals: [],
    holds: [],
    plan_sha256: "b".repeat(64),
  } as Awaited<ReturnType<typeof desktopApi.planProfileRecovery>>;
  const plan = vi
    .spyOn(desktopApi, "planProfileRecovery")
    .mockResolvedValueOnce({ ...reviewed, current: revision(4, "Shipwright 9.4", true) })
    .mockResolvedValueOnce({
      ...reviewed,
      holds: [
        {
          code: "not_found",
          message: "The exact stored mod file is missing.",
          details: { package: "hd.o2r" },
        },
      ],
    })
    .mockResolvedValueOnce(reviewed);
  const apply = vi.spyOn(desktopApi, "applyProfileRecovery").mockResolvedValue(current);
  vi.mocked(picker.pickModPackagePath).mockResolvedValue("/mods/ui.o2r");
  vi.spyOn(desktopApi, "planLocalModPackage").mockResolvedValue(localPlan);
  const host = await render();

  expect(history).not.toHaveBeenCalled();
  const openHistory = button(host, "Setup history");
  await act(async () => button(host, "Add mod file…").click());
  expect(openHistory.disabled).toBe(true);
  expect(button(host, "Retained game versions").disabled).toBe(true);
  await act(async () => button(host, "Don’t add").click());
  await expect.element(page.getByRole("button", { name: "Add mod file…" })).toHaveFocus();
  expect(openHistory.disabled).toBe(false);
  await act(async () => openHistory.click());
  expect(history).toHaveBeenCalledWith("shipwright", "default", 7);
  await act(async () => button(host, "Review revision 2").click());
  expect(plan).toHaveBeenCalledWith("shipwright", "default", 2, 7);
  expect(host.textContent).toContain("This game changed.");
  expect(host.textContent).not.toContain("Recover setup");
  await act(async () => button(host, "Review revision 2").click());
  expect(document.activeElement?.textContent).toBe("Recover revision 2");
  expect(host.textContent).toContain("Your current progress stays in this setup.");
  expect(host.textContent).toContain("Shipwright 9.3");
  expect(host.textContent).toContain("hd.o2r · Disabled");
  expect(host.textContent).toContain("hd.o2r · The exact stored mod file is missing.");
  expect(button(host, "Recover setup").disabled).toBe(true);
  expect(apply).not.toHaveBeenCalled();

  await act(async () => button(host, "Close recovery review").click());
  expect(document.activeElement).toBe(button(host, "Review revision 2"));
  await act(async () => button(host, "Review revision 2").click());
  await act(async () => button(host, "Recover setup").click());
  expect(apply).toHaveBeenCalledWith("shipwright", "default", 2, reviewed.plan_sha256, 7);
  expect(read).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain("Recovered the setup and kept its current progress.");
});

it("can finish the selected setup change even when partially placed files appear unmanaged", async () => {
  vi.spyOn(desktopApi, "modSetups").mockResolvedValue(
    view({
      live: {
        profile_id: "default",
        revision: 2,
        unmanaged: ["new.o2r"],
        changed_owned: [],
        native_list: { state: "in-sync" },
      },
    }),
  );
  const finish = vi
    .spyOn(desktopApi, "useModSetup")
    .mockResolvedValue({} as Awaited<ReturnType<typeof desktopApi.useModSetup>>);
  const host = await render();
  expect(host.textContent).toContain("Finish the setup change before playing.");
  await act(async () => button(host, "Finish using Default").click());
  expect(finish).toHaveBeenCalledWith("shipwright", "default", 7);
  expect(host.textContent).toContain("Finished applying the setup change.");
});

it("retires an exact recovery offer only after review and refreshes the retained versions", async () => {
  vi.spyOn(desktopApi, "modSetups").mockResolvedValue(view());
  const revision = {
    revision: 7,
    build: {
      port_id: "shipwright",
      install_id: "ship-previous",
      manifest_sha256: "a".repeat(64),
      installed_contract_sha256: "b".repeat(64),
      artifact: { asset_name: "ship-previous.zip" },
    },
  } as unknown as Awaited<ReturnType<typeof desktopApi.previewModSetupRetirement>>["revision"];
  const read = vi
    .spyOn(desktopApi, "modSetupRecoveryBuilds")
    .mockResolvedValueOnce([{ revision, availability: "verified", install: null, gap: null }])
    .mockResolvedValue([]);
  const preview = vi
    .spyOn(desktopApi, "previewModSetupRetirement")
    .mockResolvedValueOnce({ setup_id: "other-setup", revision, preview_sha256: "c".repeat(64) })
    .mockResolvedValue({ setup_id: "default", revision, preview_sha256: "d".repeat(64) });
  const apply = vi.spyOn(desktopApi, "retireModSetupRecoveryBuild").mockResolvedValue(revision);
  await render();

  const history = page.getByRole("button", { name: /^(Hide )?retained game versions$/i });
  await history.click();
  const review = page.getByRole("button", { name: "Review retiring ship-previous.zip (offer 7)" });
  await review.click();
  const dialog = page.getByRole("dialog");
  await expect.element(dialog.getByText("This game changed.", { exact: false })).toBeVisible();
  await expect.element(dialog.getByRole("heading")).toHaveFocus();
  await expect
    .element(dialog.getByRole("button", { name: "Retire recovery offer" }))
    .not.toBeInTheDocument();
  await dialog.getByRole("button", { name: "Keep recovery offer" }).click();
  await expect.element(review).toHaveFocus();
  expect(apply).not.toHaveBeenCalled();

  await review.click();
  await expect.element(dialog.getByText("ship-previous.zip")).toBeVisible();
  await dialog.getByRole("button", { name: "Retire recovery offer" }).click();
  expect(preview).toHaveBeenLastCalledWith("shipwright", "default", 7, 7);
  expect(apply).toHaveBeenCalledExactlyOnceWith("shipwright", "default", 7, "d".repeat(64), 7);
  await expect.element(page.getByText("Recovery offer retired.")).toBeVisible();
  await expect.element(review).not.toBeInTheDocument();
  await expect.element(history).toHaveFocus();
  expect(read).toHaveBeenCalledTimes(2);
});

it("moves a reviewed unmanaged file and gives its preserved location for ordinary package review", async () => {
  const fileName = "hand-added.o2r";
  const plan: ModFilePreservationPlan = {
    port_id: "shipwright",
    profile_id: "default",
    revision: 3,
    revision_sha256: "a".repeat(64),
    file_name: fileName,
    slot: 0,
    plan_sha256: "b".repeat(64),
    observed: { sha256: "c".repeat(64), size: 8 },
    restore: null,
  };
  const read = vi
    .spyOn(desktopApi, "modSetups")
    .mockResolvedValueOnce(view())
    .mockResolvedValueOnce(
      view({
        live: {
          profile_id: "default",
          revision: 3,
          unmanaged: [fileName],
          changed_owned: [],
          native_list: { state: "in-sync" },
        },
      }),
    )
    .mockResolvedValue(view());
  const inspect = vi.spyOn(desktopApi, "inspectModFile").mockResolvedValue(plan);
  const preserve = vi.spyOn(desktopApi, "preserveModFile").mockResolvedValue({
    plan,
    preserved_path: "D:/Library/preserved/hand-added.o2r",
  });
  vi.mocked(picker.pickModPackagePath).mockResolvedValue("/mods/ui.o2r");
  vi.spyOn(desktopApi, "planLocalModPackage").mockResolvedValue(localPlan);
  const host = await render();
  await act(async () => button(host, "Add mod file…").click());

  const root = mounted.at(-1)?.root;
  if (!root) throw new Error("setup control did not mount");
  await act(async () => root.render(<ModSetupsControl portId="shipwright" generation={7} busy />));
  await act(async () =>
    root.render(<ModSetupsControl portId="shipwright" generation={7} busy={false} />),
  );
  const review = button(host, "Review file");
  expect(review.disabled).toBe(true);
  await act(async () => button(host, "Don’t add").click());
  expect(review.disabled).toBe(false);
  expect(button(host, "Add mod file…").disabled).toBe(true);
  await act(async () => review.click());
  expect(inspect).toHaveBeenCalledWith("shipwright", fileName, 7);
  expect(preserve).not.toHaveBeenCalled();
  await act(async () => button(host, "Preserve file").click());
  expect(preserve).toHaveBeenCalledWith("shipwright", fileName, plan.plan_sha256, 7);
  expect(read).toHaveBeenCalledTimes(3);
  expect(host.textContent).toContain("D:/Library/preserved/hand-added.o2r");
  expect(button(host, "Add mod file…").disabled).toBe(false);
});

it("creates a named clean setup when the current runtime is verified and none is ready", async () => {
  const withBuild = (entry: ReturnType<typeof setup>) => ({
    ...entry,
    build_availability: "verified",
    revision: {
      ...entry.revision,
      build: {
        port_id: "shipwright",
        install_id: "exact",
        artifact: { asset_name: "ship-exact.zip" },
      },
    },
  });
  const source = withBuild(setup("default", "Default", 3, [["hd.o2r", true]]));
  const clean = withBuild(setup("fresh", "Weekend clean", 1, []));
  const withProfiles = (profiles: (typeof source)[]) =>
    view({ inventory: { port_id: "shipwright", profiles } } as unknown as Partial<ModSetupsView>);
  vi.spyOn(desktopApi, "modSetups")
    .mockResolvedValueOnce(withProfiles([source]))
    .mockResolvedValue(withProfiles([source, clean]));
  const create = vi
    .spyOn(desktopApi, "createCleanModSetup")
    .mockResolvedValue(clean.profile as Awaited<ReturnType<typeof desktopApi.createCleanModSetup>>);
  const activate = vi.spyOn(desktopApi, "useModSetup");
  await render();

  const open = page.getByRole("button", { name: "Create clean setup…" });
  await open.click();
  const name = page.getByRole("textbox", { name: "Clean setup name" });
  await expect.element(name).toHaveFocus();
  await expect.element(page.getByText("ship-exact.zip")).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(create).not.toHaveBeenCalled();
  await expect.element(open).toHaveFocus();

  await open.click();
  await name.fill("  Weekend clean  ");
  await page.getByRole("button", { name: "Create setup", exact: true }).click();
  expect(create).toHaveBeenCalledExactlyOnceWith("shipwright", "default", "Weekend clean", 3, 7);
  expect(activate).not.toHaveBeenCalled();
  await expect
    .element(page.getByText("Created clean setup Weekend clean with fresh progress."))
    .toBeVisible();
  await expect.element(open).not.toBeInTheDocument();
});

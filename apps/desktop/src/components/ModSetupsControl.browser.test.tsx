import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { desktopApi } from "../api";
import * as picker from "../file-picker";
import * as standingSetup from "../features/game-file-discovery/use-standing-setup";
import type {
  ModFilePreservationPlan,
  ModSetupOriginalReview,
  ModSetupView,
  ModSetupsView,
} from "../types";
import type {
  TransportOutputs,
  OutputDesktopRecipeImportReview,
} from "../transport-types.generated";
import { sourceProfile } from "../test-fixtures";
import { ModFilePreservationControl } from "./ModFilePreservationControl";
import { ModSetupsControl } from "./ModSetupsControl";
import "../styles/index.css";

vi.mock("../file-picker", { spy: true });
vi.mock("../features/game-file-discovery/use-standing-setup", { spy: true });

type RecipeImportPlan = TransportOutputs["recipe_import_plan"];

function recipeReview(plan: RecipeImportPlan): OutputDesktopRecipeImportReview {
  return {
    plan,
    serialized_plan: JSON.stringify(plan),
    setting_values: plan.recipe.settings?.map((setting) => String(setting.value)) ?? [],
  };
}

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

async function render(
  busy = false,
  openGameFiles?: () => void,
  generation = 7,
  libraryRoot?: string,
) {
  vi.spyOn(desktopApi, "previewModSetupDraft").mockResolvedValue({
    order: [],
    conflicts: [],
    conflicts_truncated: false,
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () =>
    root.render(
      <ModSetupsControl
        portId="shipwright"
        generation={generation}
        busy={busy}
        openGameFiles={openGameFiles}
        libraryRoot={libraryRoot}
      />,
    ),
  );
  await act(async () => {
    host.querySelector<HTMLButtonElement>(".mod-workspace-views button:last-child")?.click();
    const setupList = host.querySelector("details:has(> ul[aria-label])");
    if (setupList instanceof HTMLDetailsElement) setupList.open = true;
  });
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
    .spyOn(desktopApi, "applyModSetupDraft")
    .mockResolvedValue({} as Awaited<ReturnType<typeof desktopApi.applyModSetupDraft>>);
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
  expect(toggle).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Will turn off");

  await act(async () => button(host, "Use Clean").click());
  expect(use).toHaveBeenCalledWith("shipwright", "clean", 7);
  expect(read).toHaveBeenCalledTimes(2);
});

it.each([
  ["custom", null],
  ["default", null],
  ["custom", "gamebanana"],
  ["default", "gamebanana"],
] as const)(
  "keeps one selected package state across switches and repeated empty reads from %s with provider %s",
  async (initialProfile, provider) => {
    const packages: [string, boolean][] = [
      ["textures.o2r", true],
      ["music.otr", false],
      ["interface.o2r", true],
      ["effects.otr", true],
    ];
    const profile = (id: "default" | "custom"): ModSetupView => {
      const entry =
        id === "default" ? setup(id, "Default", 1, []) : setup(id, "Custom", 2, packages);
      return {
        ...entry,
        build_availability: "verified",
        profile: {
          ...entry.profile,
          created_at: 0,
          updated_at: 0,
          intent: { update_policy: "keep_current" },
        },
        revision: {
          ...entry.revision,
          created_at: 0,
          digest: "b".repeat(64),
          originals: [],
          parent_revision: null,
          save_group: id,
          build: {
            artifact: { asset_name: "fixture.zip", sha256: "c".repeat(64), size: 1 },
            definition: null,
            install_id: "fixture-install",
            installed_contract_sha256: "d".repeat(64),
            manifest_sha256: "e".repeat(64),
            platform: "windows-x86-64",
            port_id: "shipwright",
            runtime: null,
            selected_executable: "fixture.exe",
          },
        },
      };
    };
    const snapshot = (profileId: "default" | "custom"): ModSetupsView => ({
      port_id: "shipwright",
      supported: true,
      package_types: ["o2r", "otr"],
      later_mods_take_priority: true,
      held_updates: [],
      provider,
      inventory: {
        port_id: "shipwright",
        profiles: [profile("default"), profile("custom")],
      },
      live: {
        profile_id: profileId,
        revision: profileId === "default" ? 1 : 2,
        unmanaged: [],
        changed_owned: [],
        native_list: { state: "in-sync" },
      },
    });
    let refresh!: () => void;
    vi.spyOn(standingSetup, "onStandingSetupPass").mockImplementation((listener) => {
      refresh = listener;
      return () => {};
    });
    let finishRead!: (next: ModSetupsView) => void;
    const read = vi
      .spyOn(desktopApi, "modSetups")
      .mockResolvedValueOnce(snapshot(initialProfile))
      .mockImplementation(() => new Promise((resolve) => (finishRead = resolve)));
    const use = vi
      .spyOn(desktopApi, "useModSetup")
      .mockResolvedValue({} as Awaited<ReturnType<typeof desktopApi.useModSetup>>);
    const host = await render();
    const packageArea = (name: string) => {
      const regions = host.querySelectorAll<HTMLElement>('section[aria-label^="Mods in "]');
      expect(regions).toHaveLength(1);
      expect(regions[0]!.getAttribute("aria-label")).toBe(`Mods in ${name}`);
      const areas = regions[0]!.querySelectorAll<HTMLElement>(':scope > div[tabindex="-1"]');
      expect(areas).toHaveLength(1);
      return areas[0]!;
    };
    const expectCustomPackages = () => {
      const area = packageArea("Custom");
      expect(area.querySelectorAll("ul")).toHaveLength(1);
      expect(area.querySelectorAll("li")).toHaveLength(4);
      expect(area.textContent).not.toContain("No mods.");
      for (const [name, enabled] of packages) {
        const label = [...area.querySelectorAll("label")].find(
          (entry) => entry.textContent === name,
        )!;
        const checkbox = label.querySelector<HTMLElement>('[role="checkbox"]')!;
        expect(checkbox.getAttribute("aria-checked")).toBe(String(enabled));
        expect(checkbox.hasAttribute("disabled")).toBe(false);
        expect(checkbox.getAttribute("aria-disabled")).not.toBe("true");
      }
      return area;
    };
    const expectDefaultPackages = () => {
      const area = packageArea("Default");
      expect(area.querySelectorAll("ul, li, [role=checkbox]")).toHaveLength(0);
      expect(area.querySelectorAll("p")).toHaveLength(1);
      expect(area.textContent).toBe("No mods. The game plays without changes in this setup.");
      for (const [name] of packages) expect(area.textContent).not.toContain(name);
      return area;
    };
    const startsPopulated = initialProfile === "custom";
    const initialArea = { custom: expectCustomPackages, default: expectDefaultPackages }[
      initialProfile
    ]();
    if (startsPopulated) await act(async () => button(host, "Switch to clean play").click());
    expect(use.mock.calls).toEqual(startsPopulated ? [["shipwright", "default", 7]] : []);
    expect(read).toHaveBeenCalledTimes(startsPopulated ? 2 : 1);
    expect(button(host, "Add mod file…").disabled).toBe(startsPopulated);
    expect(initialArea.querySelectorAll('[role="checkbox"][aria-disabled="true"]')).toHaveLength(
      startsPopulated ? 4 : 0,
    );
    const heading = page.getByRole("heading", { name: "Setups and mods", exact: true });
    heading.element().focus();
    if (startsPopulated) await act(async () => finishRead(snapshot("default")));
    const defaultArea = expectDefaultPackages();
    expect(initialArea.isConnected).toBe(!startsPopulated);
    expect(button(host, "Add mod file…").disabled).toBe(false);
    await expect.element(heading).toHaveFocus();

    for (let refreshIndex = 0; refreshIndex < 3; refreshIndex++) {
      await act(async () => refresh());
      expect(read).toHaveBeenCalledTimes(Number(startsPopulated) + refreshIndex + 2);
      await act(async () => finishRead(snapshot("default")));
      expect(expectDefaultPackages()).toBe(defaultArea);
      await expect.element(heading).toHaveFocus();
    }

    await act(async () => button(host, "Use Custom").click());
    expect(use).toHaveBeenLastCalledWith("shipwright", "custom", 7);
    expect(read).toHaveBeenCalledTimes(startsPopulated ? 6 : 5);
    expect(button(host, "Add mod file…").disabled).toBe(true);
    expectDefaultPackages();
    heading.element().focus();
    await act(async () => finishRead(snapshot("custom")));
    expectCustomPackages();
    expect(defaultArea.isConnected).toBe(false);
    expect(button(host, "Add mod file…").disabled).toBe(false);
    expect(use).toHaveBeenCalledTimes(startsPopulated ? 2 : 1);
    await expect.element(heading).toHaveFocus();
  },
);

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
  expect(host.textContent).toContain("the newer file from GameBanana under Installed mods");
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
  expect(button(bound, "Browse mods").disabled).toBe(false);
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
    expect(host.textContent).toContain("راجع الملفات الأحدث من GameBanana ضمن التعديلات المثبّتة");
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
  await act(async () => (update.element() as HTMLButtonElement).click());
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

  await act(async () =>
    (page.getByRole("checkbox", { name: "Copy supported saves" }).element() as HTMLElement).click(),
  );
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
    .spyOn(desktopApi, "applyModSetupDraft")
    .mockResolvedValue({} as Awaited<ReturnType<typeof desktopApi.applyModSetupDraft>>);
  const host = await render();
  const preview = vi.mocked(desktopApi.previewModSetupDraft).mockResolvedValue({
    order: [],
    conflicts: [],
    conflicts_truncated: false,
    local_code_packages: [localPlan.native_id],
  });
  await act(async () => button(host, "Add mod file…").click());
  expect(review).toHaveBeenCalledWith("shipwright", "default", "/mods/timer.nrm", 3, 7, true);
  expect(add).not.toHaveBeenCalled();
  expect(host.textContent).toContain("This exact mod runs its own code inside the game");
  expect(host.textContent).toContain("speedrun_timer.nrm");
  expect([...host.querySelectorAll("code[dir=ltr]")].map((code) => code.textContent)).toContain(
    "b".repeat(64),
  );

  await act(async () => button(host, "Don’t add").click());
  expect(add).not.toHaveBeenCalled();

  await act(async () => button(host, "Add mod file…").click());
  await act(async () => button(host, "Queue file").click());
  expect(add).not.toHaveBeenCalled();
  await act(async () => button(host, "Review changes").click());
  await act(async () => button(host, "Check files").click());
  const edits = {
    packages: [],
    order: null,
    local_files: [{ path: "/mods/timer.nrm", expected_plan_sha256: "c".repeat(64) }],
  };
  expect(preview).toHaveBeenCalledWith("shipwright", "default", 3, [], edits, 7);
  expect(add).not.toHaveBeenCalled();
  await act(async () => button(host, "Allow this code and apply changes").click());
  expect(add).toHaveBeenCalledWith("shipwright", "default", 3, [], edits, 7, true);
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
    .spyOn(desktopApi, "applyModSetupDraft")
    .mockResolvedValue({} as Awaited<ReturnType<typeof desktopApi.applyModSetupDraft>>);
  const host = await render();
  await act(async () => button(host, "Add mod file…").click());
  expect(host.textContent).toContain("The replacement stays off.");
  expect(host.textContent).toContain("Replaces ui.otr");
  expect(add).not.toHaveBeenCalled();
  await act(async () => button(host, "Queue file").click());
  expect(add).not.toHaveBeenCalled();
  await act(async () => button(host, "Review changes").click());
  await act(async () => button(host, "Check files").click());
  await act(async () => button(host, "Apply changes").click());
  expect(add).toHaveBeenCalledWith(
    "shipwright",
    "default",
    3,
    [],
    {
      packages: [],
      order: null,
      local_files: [{ path: "/mods/ui.o2r", expected_plan_sha256: "c".repeat(64) }],
    },
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
  expect(host.textContent).toContain("the newer file from Thunderstore under Installed mods");
  expect(host.textContent).not.toContain("GameBanana");
  expect(
    [...host.querySelectorAll("button")].some(
      (candidate) => candidate.textContent?.trim() === "Browse mods",
    ),
  ).toBe(true);
});

it("saves the provider update policy on the selected setup", async () => {
  vi.spyOn(desktopApi, "modSetups").mockResolvedValue(view({ provider: "gamebanana" }));
  const save = vi
    .spyOn(desktopApi, "setModUpdatePolicy")
    .mockResolvedValue(
      setup("default", "Default", 3, []).profile as Awaited<
        ReturnType<typeof desktopApi.setModUpdatePolicy>
      >,
    );
  await render();

  await page.getByRole("combobox", { name: "Mod updates" }).selectOptions("automatic_eligible");

  expect(save).toHaveBeenCalledExactlyOnceWith("shipwright", "default", "automatic_eligible", 7);
  await expect.element(page.getByText("Saved how this setup updates mods.")).toBeVisible();
});

it("opens review for the exact project named by a saved automatic hold", async () => {
  const ready = view({
    provider: "gamebanana",
    last_automatic_checks: [
      {
        profile_id: "default",
        native_ids: ["hd.o2r"],
        project_id: "42",
        candidate_file_id: "11",
        checked_at: 1_700_000_000,
        result: { outcome: "held", reason: "This update needs permission to run mod code." },
      },
    ],
  });
  const active = ready.inventory?.profiles[0];
  if (!active) throw new Error("missing selected setup fixture");
  const installed = active.revision.packages?.find(({ native_id }) => native_id === "hd.o2r");
  if (!installed) throw new Error("missing installed provider mod");
  installed.provider = { provider: "gamebanana", project: "42", file: "10" };
  active.profile.intent = { update_policy: "automatic_eligible" };
  vi.spyOn(desktopApi, "modSetups").mockResolvedValue(ready);
  const project = vi.spyOn(desktopApi, "providerProject").mockRejectedValue(new Error("offline"));
  await render();

  await expect.element(page.getByText("Update needs review.", { exact: false })).toBeVisible();
  await act(async () => {
    (
      page.getByRole("button", { name: "Review update files" }).element() as HTMLButtonElement
    ).click();
  });

  expect(project).toHaveBeenCalledExactlyOnceWith("shipwright", "42", 7, "gamebanana");
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
  await act(async () => {
    (
      page.getByRole("button", { name: "Switch to clean play" }).element() as HTMLButtonElement
    ).click();
  });
  expect(use).toHaveBeenCalledWith("shipwright", "default", 7);
});

it("offers a present clean setup while retaining known runtime failures and Core refusals", async () => {
  const data = view();
  const { inventory, live } = data;
  const [defaultSetup, customized] = inventory?.profiles ?? [];
  if (!inventory || !live || !defaultSetup || !customized)
    throw new Error("The fixture must have two setup revisions.");
  inventory.profiles = [
    {
      ...defaultSetup,
      build_availability: "present",
      revision: { ...defaultSetup.revision, packages: [], orderings: [] },
    },
    { ...customized, build_availability: "held" },
    {
      ...customized,
      profile: { ...customized.profile, id: "missing", display_name: "Missing files" },
      revision: { ...customized.revision, profile_id: "missing" },
      build_availability: "missing",
    },
  ];
  live.profile_id = customized.profile.id;
  live.revision = customized.profile.current_revision;
  vi.spyOn(desktopApi, "modSetups").mockResolvedValue(data);
  const use = vi
    .spyOn(desktopApi, "useModSetup")
    .mockRejectedValue(new Error("The installed runtime changed. Review this setup again."));
  const host = await render();
  const clean = page.getByRole("button", { name: "Switch to clean play" });
  const row = clean.element().closest("li");
  expect(row?.textContent).toContain(
    "Installed game files are checked before play or copying this setup.",
  );
  expect(row?.textContent).not.toContain("runtime needs attention");
  expect(host.textContent?.match(/This setup’s runtime needs attention\./g)).toHaveLength(2);
  expect(host.textContent).not.toContain("verified");
  await expect
    .element(page.getByRole("button", { name: "Create clean setup…" }))
    .not.toBeInTheDocument();
  await act(async () => (clean.element() as HTMLButtonElement).click());
  expect(use).toHaveBeenCalledExactlyOnceWith("shipwright", "default", 7);
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("The installed runtime changed. Review this setup again.");
  expect(host.textContent).not.toContain("Now using");
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
    (
      page.getByRole("combobox", { name: /^Other registered originals/ }).element() as HTMLElement
    ).click(),
  );
  await act(async () =>
    (page.getByRole("option", { name: "D:/Other/original.z64" }).element() as HTMLElement).click(),
  );
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
  await act(async () => (choose.element() as HTMLElement).click());
  await act(async () =>
    (page.getByRole("option", { name: "D:/Other/original.z64" }).element() as HTMLElement).click(),
  );
  await act(async () => {
    const action = button(host, "Use this original");
    action.focus();
    action.click();
  });
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
  await act(async () => button(host, "Use this original").click());
  await userEvent.tab();
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
  await act(async () => (choose.element() as HTMLElement).click());
  await act(async () =>
    (page.getByRole("option", { name: "D:/Other/original.z64" }).element() as HTMLElement).click(),
  );
  await act(async () => {
    const action = button(host, "Use this original");
    action.focus();
    action.click();
  });
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
  await expect
    .element(page.getByRole("combobox", { name: /Other registered originals/ }))
    .not.toBeInTheDocument();
  await act(async () => {
    const action = button(host, "Find the same original");
    action.focus();
    action.click();
  });
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("That location is temporarily unavailable.");
  await expect.element(find).toHaveFocus();
  expect(host.textContent).toContain("D:/Old/recorded.z64");
  await act(async () => button(host, "Find the same original").click());

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
  const opener = page.getByRole("button", { name: `Review ${fileName}` });
  await opener.click();
  expect(inspect).toHaveBeenCalledWith("shipwright", fileName, 7);
  expect(preserve).not.toHaveBeenCalled();
  await expect.element(page.getByRole("heading", { name: fileName })).toHaveFocus();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect.element(opener).toHaveFocus();
  await opener.click();
  await page.getByRole("button", { name: "Preserve file", exact: true }).click();
  expect(preserve).toHaveBeenCalledWith("shipwright", fileName, plan.plan_sha256, 7);
  expect(read).toHaveBeenCalledTimes(3);
  expect(host.textContent).toContain("D:/Library/preserved/hand-added.o2r");
  expect(button(host, "Add mod file…").disabled).toBe(false);
  await expect
    .element(page.getByText("For a supported mod, use Add mod file and choose this saved file."))
    .toHaveFocus();
});

it("wraps a long file review and clears it when that file leaves the same setup revision", async () => {
  const fileName = `hand-added-${"x".repeat(112)}.o2r`;
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
  const inspect = vi.spyOn(desktopApi, "inspectModFile").mockResolvedValue(plan);
  const host = document.createElement("div");
  host.style.width = "296px";
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  const setupHeading = createRef<HTMLHeadingElement>();
  const show = (name?: string) =>
    act(async () =>
      root.render(
        <>
          <h3 ref={setupHeading} tabIndex={-1}>
            Setups and mods
          </h3>
          <button type="button">Separate focus target</button>
          <ModFilePreservationControl
            portId="shipwright"
            generation={7}
            live={{
              profile_id: "default",
              revision: 3,
              unmanaged: name ? [name] : [],
              changed_owned: [],
              native_list: { state: "in-sync" },
            }}
            disabled={false}
            setupHeading={setupHeading}
            setWorking={vi.fn()}
            perform={vi.fn()}
          />
        </>,
      ),
    );
  await show(fileName);
  await page.getByRole("button", { name: `Review ${fileName}` }).click();
  const review = page.getByRole("region", { name: fileName }).element();
  expect(review.scrollWidth).toBeLessThanOrEqual(host.clientWidth);
  await show("another-mod.o2r");
  await expect
    .element(page.getByRole("button", { name: "Preserve file", exact: true }))
    .not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Review another-mod.o2r" })).toBeVisible();
  const setupTitle = page.getByRole("heading", { name: "Setups and mods" });
  await show(fileName);
  await page.getByRole("button", { name: `Review ${fileName}` }).click();
  await expect.element(page.getByRole("heading", { name: fileName })).toHaveFocus();
  await show();
  await expect.element(setupTitle).toHaveFocus();

  await show(fileName);
  page
    .getByRole("button", { name: `Review ${fileName}` })
    .element()
    .focus();
  await show();
  await expect.element(setupTitle).toHaveFocus();

  await show(fileName);
  await page.getByRole("button", { name: `Review ${fileName}` }).click();
  const outside = page.getByRole("button", { name: "Separate focus target" });
  outside.element().focus();
  await show();
  await expect.element(outside).toHaveFocus();
  expect(inspect).toHaveBeenCalledTimes(3);
});

it.each(["verified", "present"] as const)(
  "creates a named clean setup when the current runtime is %s and none is ready",
  async (buildAvailability) => {
    const withBuild = (entry: ReturnType<typeof setup>) => ({
      ...entry,
      build_availability: buildAvailability,
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
    const revised = withBuild(setup("default", "Default", 4, [["hd.o2r", true]]));
    let current = source;
    let created = false;
    vi.spyOn(desktopApi, "modSetups").mockImplementation(async () =>
      withProfiles(created ? [current, clean] : [current]),
    );
    const create = vi
      .spyOn(desktopApi, "createCleanModSetup")
      .mockRejectedValueOnce(new Error("The library is temporarily unavailable. Try again."))
      .mockImplementationOnce(async () => {
        current = revised;
        throw new Error("The source setup changed. Review it before trying again.");
      })
      .mockImplementation(async () => {
        created = true;
        return clean.profile as Awaited<ReturnType<typeof desktopApi.createCleanModSetup>>;
      });
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
    const submit = page.getByRole("button", { name: "Create setup", exact: true });
    await submit.click();
    const error = page.getByRole("alert");
    await expect
      .element(error)
      .toHaveTextContent("The library is temporarily unavailable. Try again.");
    expect(error.element().closest("form")).toBe(name.element().closest("form"));
    await expect.element(name).toHaveValue("  Weekend clean  ");
    await expect.element(submit).toHaveFocus();
    await submit.click();
    await expect.element(name).not.toBeInTheDocument();
    await expect
      .element(error)
      .toHaveTextContent("The source setup changed. Review it before trying again.");
    expect(error.element().closest("form")).toBeNull();
    await expect.element(error).toHaveFocus();

    await open.click();
    await name.fill("  Weekend clean  ");
    await submit.click();
    expect(create.mock.calls).toEqual([
      ["shipwright", "default", "Weekend clean", 3, 7],
      ["shipwright", "default", "Weekend clean", 3, 7],
      ["shipwright", "default", "Weekend clean", 4, 7],
    ]);
    expect(activate).not.toHaveBeenCalled();
    await expect
      .element(page.getByText("Created clean setup Weekend clean with fresh progress."))
      .toBeVisible();
    await expect.element(open).not.toBeInTheDocument();
  },
);

it("reviews removal before sending the exact setup revision to Core", async () => {
  vi.spyOn(desktopApi, "modSetups").mockResolvedValue(view());
  const request = vi
    .spyOn(desktopApi, "applyModSetupDraft")
    .mockResolvedValue({} as Awaited<ReturnType<typeof desktopApi.applyModSetupDraft>>);
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
  expect(request).not.toHaveBeenCalled();
  await expect.element(page.getByText("Pending removal", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Review changes" }).click();
  await page.getByRole("button", { name: "Check files" }).click();
  await page.getByRole("button", { name: "Apply changes" }).click();
  expect(request).toHaveBeenCalledWith(
    "shipwright",
    "default",
    3,
    [],
    { packages: [{ native_id: "hd.o2r", enabled: null }], order: null, local_files: [] },
    7,
    false,
  );
  await expect.element(page.getByText("Setup changes applied.")).toBeVisible();
});

it("leaves the recipe review unchanged when the picker is cancelled", async () => {
  vi.spyOn(desktopApi, "modSetups").mockResolvedValue(view());
  let cancel!: (path: null) => void;
  const selection = new Promise<null>((resolve) => {
    cancel = resolve;
  });
  const pick = vi.spyOn(picker, "pickModRecipePath").mockReturnValue(selection);
  const inspect = vi.spyOn(desktopApi, "inspectModRecipe");
  const host = await render();
  const open = button(host, "Open setup recipe…");
  open.focus();
  await userEvent.keyboard("{Enter}");
  expect(open.getAttribute("aria-busy")).toBe("true");
  expect(document.activeElement).toBe(open);
  await userEvent.keyboard("{Enter}");
  expect(pick).toHaveBeenCalledOnce();
  await act(async () => cancel(null));
  await expect.element(page.getByRole("button", { name: "Open setup recipe…" })).toBeEnabled();
  expect(document.activeElement).toBe(open);
  expect(inspect).not.toHaveBeenCalled();
  await expect
    .element(page.getByRole("heading", { name: "Recipe review" }))
    .not.toBeInTheDocument();
});

it("opens an exact recipe review and creates a separately named setup", async () => {
  vi.spyOn(desktopApi, "modSetups").mockResolvedValue(view());
  vi.spyOn(picker, "pickModRecipePath").mockResolvedValue("/picked/setup.json");
  const plan = recipeReview({
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
      settings: [
        { native_id: "buffer.nrm", option_id: "buffer_size", value: 2048 },
        { native_id: "precise.nrm", option_id: "count", value: 9007199254740992 },
        { native_id: "precise.nrm", option_id: "zero", value: 0 },
      ],
      runtime: { platform: "windows-x86-64" },
    },
    runtime: { name: "runtime", status: "available", detail: "The exact runtime is installed." },
  } as unknown as RecipeImportPlan);
  plan.setting_values = ["2048.0", "9007199254740993", "-0.0"];
  const inspect = vi.spyOn(desktopApi, "inspectModRecipe").mockResolvedValue(plan);
  const apply = vi
    .spyOn(desktopApi, "applyModRecipe")
    .mockResolvedValue({} as Awaited<ReturnType<typeof desktopApi.applyModRecipe>>);
  await render();
  await page.getByRole("button", { name: "Open setup recipe…" }).click();
  await expect.element(page.getByRole("heading", { name: "Recipe review" })).toHaveFocus();
  expect(inspect).toHaveBeenCalledWith("shipwright", "/picked/setup.json", 7);
  await page.getByText("Recipe inputs and details").click();
  for (const value of plan.setting_values)
    await expect.element(page.getByText(value, { exact: true })).toBeVisible();
  const create = page.getByRole("button", { name: "Create setup from recipe" });
  await expect.element(create).toBeDisabled();
  await page.getByRole("textbox", { name: "Name for the new setup" }).fill("Shared setup");
  await create.click();
  expect(apply).toHaveBeenCalledWith("shipwright", "Shared setup", plan, 7, false);
  await expect.element(page.getByText("Created Shared setup with fresh progress.")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Open setup recipe…" })).toHaveFocus();
});

it("leaves focus where the player moved it during recipe inspection", async () => {
  vi.spyOn(desktopApi, "modSetups").mockResolvedValue(view());
  vi.spyOn(picker, "pickModRecipePath").mockResolvedValue("/picked/setup.json");
  type Review = Awaited<ReturnType<typeof desktopApi.inspectModRecipe>>;
  let finish!: (review: Review) => void;
  const pending = new Promise<Review>((resolve) => {
    finish = resolve;
  });
  const inspect = vi.spyOn(desktopApi, "inspectModRecipe").mockReturnValue(pending);
  const host = await render();
  await page.getByRole("button", { name: "Open setup recipe…" }).click();
  await expect.poll(() => inspect.mock.calls.length).toBe(1);
  const setupHeading = host.querySelector("h3");
  setupHeading?.focus();
  await act(async () =>
    finish(
      recipeReview({
        can_apply: false,
        holds: [],
        originals: [],
        packages: [],
        recipe: {
          identity_sha256: "a".repeat(64),
          uncaptured: [],
          packages: [],
          orderings: [],
          runtime: { platform: "windows-x86-64" },
        },
        runtime: {
          name: "runtime",
          status: "available",
          detail: "The exact runtime is installed.",
        },
      } as unknown as RecipeImportPlan),
    ),
  );
  await expect.element(page.getByRole("heading", { name: "Recipe review" })).toBeVisible();
  expect(document.activeElement).toBe(setupHeading);
});

it("shows exact missing recipe inputs before any import is offered", async () => {
  vi.spyOn(desktopApi, "modSetups").mockResolvedValue(view());
  vi.spyOn(picker, "pickModRecipePath").mockResolvedValue("/picked/setup.json");
  const plan = recipeReview({
    can_apply: false,
    holds: ["Review the exact required provider version."],
    originals: [
      { name: "original", status: "unavailable", detail: "Matching original is missing" },
    ],
    packages: [{ name: "retro.o2r", status: "unavailable", detail: "Review project 1, file 2." }],
    recipe: {
      identity_sha256: "a".repeat(64),
      uncaptured: [],
      packages: [],
      orderings: [],
      runtime: { platform: "windows-x86-64" },
    },
    runtime: { name: "runtime", status: "available", detail: "The exact runtime is installed." },
  } as unknown as RecipeImportPlan);
  vi.spyOn(desktopApi, "inspectModRecipe").mockResolvedValue(plan);
  const openGameFiles = vi.fn();
  await render(false, openGameFiles);
  const open = page.getByRole("button", { name: "Open setup recipe…" });
  await open.click();
  await expect.element(page.getByText("Review the exact required provider version.")).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Create setup from recipe" }))
    .not.toBeInTheDocument();
  await page.getByRole("button", { name: "Open Game files" }).click();
  expect(openGameFiles).toHaveBeenCalledOnce();
  await page.getByRole("button", { name: "Close review" }).click();
  await expect.element(open).toHaveFocus();
});

it("checks a named provider file and asks permission for the resulting exact code", async () => {
  vi.spyOn(desktopApi, "modSetups").mockResolvedValue(view());
  vi.spyOn(picker, "pickModRecipePath").mockResolvedValue("/picked/setup.json");
  const plan = recipeReview({
    can_apply: false,
    holds: [],
    originals: [],
    packages: [
      {
        name: "retro.nrm",
        status: "unavailable",
        detail: "Use profile provider-plan to review version 2.",
      },
    ],
    provider_checks: ["retro.nrm"],
    plan_sha256: "a".repeat(64),
    recipe: {
      identity_sha256: "a".repeat(64),
      uncaptured: [],
      packages: [
        {
          native_id: "retro.nrm",
          enabled: true,
          provider: { provider: "thunderstore", project: "Retro-Mod", file: "2.0.0" },
        },
      ],
      orderings: [],
      runtime: { platform: "windows-x86-64" },
    },
    runtime: { name: "runtime", status: "available", detail: "The exact runtime is installed." },
  } as unknown as RecipeImportPlan);
  const reviewed = recipeReview({
    ...plan.plan,
    can_apply: true,
    provider_checks: [],
    plan_sha256: "b".repeat(64),
    code_approval: [{ native_id: "retro.nrm", sha256: "c".repeat(64), runs: ["recompiled_code"] }],
  });
  vi.spyOn(desktopApi, "inspectModRecipe").mockResolvedValue(plan);
  let reject!: (error: Error) => void;
  const refused = new Promise<never>((_resolve, rejectAttempt) => {
    reject = rejectAttempt;
  });
  const acquire = vi
    .spyOn(desktopApi, "acquireModRecipePackage")
    .mockReturnValueOnce(refused)
    .mockResolvedValueOnce(reviewed);
  const apply = vi
    .spyOn(desktopApi, "applyModRecipe")
    .mockResolvedValue({} as Awaited<ReturnType<typeof desktopApi.applyModRecipe>>);
  await render();
  await page.getByRole("button", { name: "Open setup recipe…" }).click();
  await expect
    .element(page.getByText(/Check Thunderstore project Retro-Mod, file 2.0.0/))
    .toBeVisible();
  await expect.element(page.getByText(/profile provider-plan/)).not.toBeInTheDocument();
  const check = page.getByRole("button", { name: "Check provider for retro.nrm" });
  await check.click();
  await expect.element(check).toHaveFocus();
  await act(async () => reject(new Error("The provider did not return the exact file.")));
  await expect
    .element(page.getByRole("alert").getByText("The provider did not return the exact file."))
    .toBeVisible();
  await expect.element(check).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  expect(acquire).toHaveBeenCalledTimes(2);
  expect(acquire).toHaveBeenCalledWith("shipwright", expect.any(String), "retro.nrm", plan, 7);
  await page.getByRole("textbox", { name: "Name for the new setup" }).fill("Shared setup");
  const create = page.getByRole("button", { name: "Create setup from recipe" });
  await expect.element(create).toBeDisabled();
  await page
    .getByRole("checkbox", { name: "I allow the exact packages below to run mod code." })
    .click();
  await create.click();
  expect(apply).toHaveBeenCalledWith("shipwright", "Shared setup", reviewed, 7, true);
});

it.each(["accepted", "refused"] as const)(
  "keeps a reopened identical review staged after an obsolete %s import settles",
  async (outcome) => {
    vi.spyOn(desktopApi, "modSetups").mockResolvedValue(view());
    vi.spyOn(picker, "pickModRecipePath").mockResolvedValue("/picked/setup.json");
    const plan = recipeReview({
      can_apply: true,
      acquisitions: [{ native_id: "retro.nrm" }],
      holds: [],
      originals: [],
      packages: [],
      recipe: {
        identity_sha256: "a".repeat(64),
        uncaptured: [],
        packages: [],
        orderings: [],
        runtime: { platform: "windows-x86-64" },
      },
      runtime: { name: "runtime", status: "available", detail: "The exact runtime is installed." },
    } as unknown as RecipeImportPlan);
    const held = recipeReview({
      ...plan.plan,
      can_apply: false,
      acquisitions: [],
      provider_checks: ["retro.nrm"],
    });
    vi.spyOn(desktopApi, "inspectModRecipe").mockResolvedValue(held);
    const acquire = vi.spyOn(desktopApi, "acquireModRecipePackage").mockResolvedValue(plan);
    const discard = vi.spyOn(desktopApi, "discardModRecipeReview").mockResolvedValue(undefined);
    type Imported = Awaited<ReturnType<typeof desktopApi.applyModRecipe>>;
    let settle!: () => void;
    const applying = new Promise<Imported>((resolve, reject) => {
      settle =
        outcome === "accepted"
          ? () => resolve({} as Imported)
          : () => reject(new Error("The exact files changed before apply."));
    });
    const apply = vi.spyOn(desktopApi, "applyModRecipe").mockReturnValue(applying);
    await render();
    await page.getByRole("button", { name: "Open setup recipe…" }).click();
    await page.getByRole("button", { name: "Check provider for retro.nrm" }).click();
    await page.getByRole("textbox", { name: "Name for the new setup" }).fill("Shared setup");
    await page.getByRole("button", { name: "Create setup from recipe" }).click();
    expect(apply).toHaveBeenCalledWith("shipwright", "Shared setup", plan, 7, false);
    await act(async () => mounted.at(-1)?.root.render(null));
    expect(discard).not.toHaveBeenCalled();
    await render();
    const open = page.getByRole("button", { name: "Open setup recipe…" });
    await open.click();
    await page.getByRole("button", { name: "Check provider for retro.nrm" }).click();
    await expect
      .element(page.getByRole("textbox", { name: "Name for the new setup" }))
      .toBeVisible();
    expect(acquire).toHaveBeenCalledTimes(2);
    await act(async () => settle());
    expect(discard).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Close review" }).click();
    expect(discard).toHaveBeenCalledExactlyOnceWith("shipwright", plan, 7);
    await expect.element(open).toHaveFocus();
  },
);

it("explains how to check provider files when the game has no selected setup", async () => {
  vi.spyOn(desktopApi, "modSetups").mockResolvedValue(view({ inventory: null, live: null }));
  vi.spyOn(picker, "pickModRecipePath").mockResolvedValue("/picked/setup.json");
  vi.spyOn(desktopApi, "inspectModRecipe").mockResolvedValue(
    recipeReview({
      can_apply: false,
      holds: [],
      originals: [],
      packages: [{ name: "retro.nrm", status: "unavailable", detail: "Review version 2." }],
      provider_checks: ["retro.nrm"],
      plan_sha256: "a".repeat(64),
      recipe: {
        identity_sha256: "a".repeat(64),
        uncaptured: [],
        packages: [],
        orderings: [],
        runtime: { platform: "windows-x86-64" },
      },
      runtime: { name: "runtime", status: "available", detail: "The exact runtime is installed." },
    } as unknown as RecipeImportPlan),
  );
  await render();
  await page.getByRole("button", { name: "Open setup recipe…" }).click();

  await expect
    .element(page.getByText("Create or select a setup to check the exact files with the provider."))
    .toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Check provider for retro.nrm" }))
    .not.toBeInTheDocument();
});

it("keeps exact recipe identifiers, details and provider actions inside a narrow panel", async () => {
  vi.spyOn(desktopApi, "modSetups").mockResolvedValue(view());
  vi.spyOn(picker, "pickModRecipePath").mockResolvedValue("/picked/setup.json");
  const nativeId = `retro-${"y".repeat(117)}.nrm`;
  vi.spyOn(desktopApi, "inspectModRecipe").mockResolvedValue(
    recipeReview({
      can_apply: false,
      holds: [],
      originals: [],
      packages: [{ name: nativeId, status: "unavailable", detail: "Review the exact file." }],
      provider_checks: [nativeId],
      plan_sha256: "a".repeat(64),
      recipe: {
        identity_sha256: "b".repeat(64),
        uncaptured: [],
        packages: [{ native_id: nativeId, enabled: true }],
        orderings: [{ domain: "asset-override", native_ids: [nativeId] }],
        runtime: { platform: "windows-x86-64" },
      },
      runtime: { name: "runtime", status: "available", detail: "The exact runtime is installed." },
    } as unknown as RecipeImportPlan),
  );
  const host = await render();
  host.style.width = "296px";
  await page.getByRole("button", { name: "Open setup recipe…" }).click();
  const review = page.getByRole("region", { name: "Recipe review" }).element();
  expect(review.scrollWidth).toBeLessThanOrEqual(host.clientWidth);
  const check = page.getByRole("button", { name: `Check provider for ${nativeId}` }).element();
  expect(check.getBoundingClientRect().right).toBeLessThanOrEqual(
    host.getBoundingClientRect().right,
  );
});

it("serializes local-change and standing-pass inventory readback without publishing the older read", async () => {
  let pass!: () => void;
  vi.spyOn(standingSetup, "onStandingSetupPass").mockImplementation((listener) => {
    pass = listener;
    return () => {};
  });
  let finishOld!: (next: ModSetupsView) => void;
  let finishNew!: (next: ModSetupsView) => void;
  const old = new Promise<ModSetupsView>((resolve) => {
    finishOld = resolve;
  });
  const next = new Promise<ModSetupsView>((resolve) => {
    finishNew = resolve;
  });
  const read = vi
    .spyOn(desktopApi, "modSetups")
    .mockResolvedValueOnce(view({ inventory: null, live: null }))
    .mockReturnValueOnce(old)
    .mockReturnValueOnce(next);
  vi.spyOn(desktopApi, "createDefaultModSetup").mockResolvedValue(
    {} as Awaited<ReturnType<typeof desktopApi.createDefaultModSetup>>,
  );
  const host = await render(false, undefined, 701);
  await act(async () => button(host, "Create first setup").click());
  expect(read).toHaveBeenCalledTimes(2);
  await act(async () => {
    pass();
    pass();
  });
  expect(read).toHaveBeenCalledTimes(2);
  await act(async () => finishOld(view({ inventory: null, live: null })));
  expect(read).toHaveBeenCalledTimes(3);
  expect(button(host, "Create first setup").disabled).toBe(true);
  await act(async () => finishNew(view()));
  expect(host.textContent).toContain("Default");
  expect(host.textContent).not.toContain("Create first setup");
  expect(button(host, "Use Clean").disabled).toBe(false);
});

it("waits for a retired component's native read before reading the same port on remount", async () => {
  let finishRetired!: (next: ModSetupsView) => void;
  const retired = new Promise<ModSetupsView>((resolve) => {
    finishRetired = resolve;
  });
  const read = vi
    .spyOn(desktopApi, "modSetups")
    .mockReturnValueOnce(retired)
    .mockResolvedValueOnce(view());
  await render(false, undefined, 702);
  const first = mounted.pop()!;
  await act(async () => first.root.unmount());
  first.host.remove();
  const host = await render(false, undefined, 702);
  expect(read).toHaveBeenCalledTimes(1);
  await act(async () => finishRetired(view({ inventory: null, live: null })));
  expect(read).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain("Default");
  expect(host.textContent).not.toContain("Create first setup");
});

it("fences an old inventory result when the workspace generation is replaced", async () => {
  let finishOld!: (next: ModSetupsView) => void;
  const old = new Promise<ModSetupsView>((resolve) => {
    finishOld = resolve;
  });
  const read = vi
    .spyOn(desktopApi, "modSetups")
    .mockReturnValueOnce(old)
    .mockResolvedValueOnce(view());
  const host = await render(false, undefined, 703);
  const { root } = mounted.at(-1)!;
  await act(async () =>
    root.render(<ModSetupsControl portId="shipwright" generation={704} busy={false} />),
  );
  expect(read).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain("Default");
  await act(async () => finishOld(view({ inventory: null, live: null })));
  expect(host.textContent).toContain("Default");
  expect(host.textContent).not.toContain("Create first setup");
});

it("restores the Installed search and status after showing the full load order", async () => {
  vi.spyOn(desktopApi, "modSetups").mockResolvedValue(view());
  const host = await render();
  const search = page.getByRole("searchbox", { name: "Search installed mods" });
  const status = page.getByRole("combobox", { name: /Installation status/ });
  await act(async () => (status.element() as HTMLButtonElement).click());
  await act(async () =>
    (page.getByRole("option", { name: "Enabled", exact: true }).element() as HTMLElement).click(),
  );
  await search.fill("hd");
  await expect.element(page.getByRole("checkbox", { name: "sfx.otr" })).not.toBeInTheDocument();
  await act(async () => button(host, "Edit order").click());
  await expect.element(page.getByRole("checkbox", { name: "sfx.otr" })).toBeVisible();
  await act(async () => button(host, "Done").click());
  await expect.element(search).toHaveValue("hd");
  await expect.element(status).toHaveAccessibleName("Installation status Enabled");
  await expect.element(page.getByRole("checkbox", { name: "sfx.otr" })).not.toBeInTheDocument();
});

it("keeps the older draft when storage cannot save the recovered addition", async () => {
  const library = "draft-quota-test";
  const scope = `portcove.mod-draft.${JSON.stringify([library, "shipwright", "default"])}`;
  const previous = `${scope}.2`;
  const current = `${scope}.3`;
  const older = JSON.stringify({
    additions: [
      { provider: "gamebanana", project: "42", file: "73", name: "HD Link", fileName: "hd.otr" },
    ],
    packages: [],
    order: null,
  });
  vi.spyOn(desktopApi, "modSetups").mockResolvedValue(view({ provider: "gamebanana" }));
  localStorage.setItem(previous, older);
  const write = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
    if (key === current) throw new DOMException("Quota exceeded", "QuotaExceededError");
    write.call(this, key, value);
  });
  try {
    const host = await render(false, undefined, 7, library);
    await act(async () => button(host, "Recover additions").click());
    expect(localStorage.getItem(current)).toBeNull();
    expect(localStorage.getItem(previous)).toBe(older);
    expect(button(host, "Review changes").disabled).toBe(false);
  } finally {
    localStorage.removeItem(previous);
    localStorage.removeItem(current);
  }
});

function fixtureProviderMods() {
  const listing = (project_id: string, name: string) => ({
    provider: "gamebanana",
    project_id,
    name,
    version: "1.0",
    updated_at: 1,
    game_id: "16121",
    obsolete: false,
    profile_url: `https://gamebanana.com/mods/${project_id}`,
    submitter: null,
    files: [],
    unreadable_files: 0,
  });
  const installed = listing("42", "HD Link");
  const addition = listing("43", "Retro HUD");
  vi.spyOn(desktopApi, "modProviderCatalog").mockResolvedValue({
    projects: [installed, addition],
    legacy_game_id: "16121",
    complete: true,
    observed_at: 1,
    freshness: "fresh",
  });
  vi.spyOn(desktopApi, "providerProject").mockImplementation(async (_port, id) => ({
    port_id: "shipwright",
    game_name: "Ship of Harkinian",
    project:
      id === installed.project_id
        ? installed
        : {
            ...addition,
            files: [
              {
                file_id: "9",
                file_name: "retro-hud.zip",
                size: 4096,
                added_at: 1,
                download_url: "https://gamebanana.com/dl/9",
                claimed_md5: null,
                archived: false,
                claimed_scan: "clean",
              },
            ],
          },
    eligible_file_ids: id === installed.project_id ? [] : ["9"],
    observed_at: 1,
    freshness: "fresh",
  }));
}

function linkedSetup() {
  const entry = setup("default", "Default", 3, [
    ["hd.o2r", true],
    ["sfx.otr", false],
  ]);
  return {
    ...entry,
    revision: {
      ...entry.revision,
      packages: [
        {
          ...entry.revision.packages[0]!,
          provider: { provider: "gamebanana", project: "42", file: "8" },
        },
        entry.revision.packages[1]!,
      ],
    },
  };
}

it.each(["Browse mods", "Installed mods"] as const)(
  "undoes a removal queued from %s without losing either earlier edit or load order",
  async (entry) => {
    fixtureProviderMods();
    vi.spyOn(desktopApi, "modSetups").mockResolvedValue(
      view({
        provider: "gamebanana",
        inventory: { port_id: "shipwright", profiles: [linkedSetup()] } as unknown as NonNullable<
          ModSetupsView["inventory"]
        >,
      }),
    );
    const host = await render();
    const click = async (label: string) => act(async () => button(host, label).click());
    const control = (label: string) =>
      page.getByRole("checkbox", { name: label, exact: false }).element() as HTMLElement;
    await act(async () => control("hd.o2r").click());
    await act(async () => control("sfx.otr").click());
    await click("Edit order");
    const move = page.getByRole("button", { name: "Move hd.o2r up" });
    await act(async () => (move.element() as HTMLElement).click());
    await click("Done");
    const browseDetails = async () => {
      await click("Browse mods");
      const result = page.getByRole("button", { name: "HD Link" });
      await expect.element(result).toBeVisible();
      await act(async () => (result.element() as HTMLElement).click());
    };
    if (entry === "Browse mods") {
      await browseDetails();
      await click("Remove from setup");
      await click("Installed mods 2");
      await click("Undo removal");
    } else {
      const remove = page.getByRole("button", { name: "Remove hd.o2r from this setup" });
      await act(async () => (remove.element() as HTMLElement).click());
      await click("Confirm removal");
      await browseDetails();
      await click("Undo removal");
    }
    await click("Review changes");
    const review = page.getByRole("heading", { name: "Review changes" }).element()?.parentElement;
    expect(review?.textContent).toContain("Will turn off hd.o2r");
    expect(review?.textContent).toContain("Will turn on sfx.otr");
    expect(review?.textContent).toContain("New load order hd.o2r · sfx.otr");
    expect(review?.textContent).not.toContain("Pending removal");
    await click("Check files");
    expect(desktopApi.previewModSetupDraft).toHaveBeenCalledWith(
      "shipwright",
      "default",
      3,
      [],
      {
        local_files: [],
        packages: [
          { native_id: "sfx.otr", enabled: true },
          { native_id: "hd.o2r", enabled: false },
        ],
        order: ["hd.o2r", "sfx.otr"],
      },
      7,
    );
  },
);

it("filters pending provider and local additions and counts them only after Apply", async () => {
  fixtureProviderMods();
  const initial = view({ provider: "gamebanana", applied_package_count: 2 });
  const read = vi.spyOn(desktopApi, "modSetups").mockResolvedValue(initial);
  const providerPlan = {
    port_id: "shipwright",
    profile_id: "default",
    expected_revision: 3,
    provider: { provider: "gamebanana", project: "43", file: "9" },
    file: { file_id: "9", file_name: "retro-hud.zip" },
    members: [],
    replaces: [],
    conflicts: [],
    unverified_claims: [],
  } as unknown as Awaited<ReturnType<typeof desktopApi.planProviderInstall>>;
  vi.spyOn(desktopApi, "planProviderInstall").mockResolvedValue(providerPlan);
  vi.mocked(picker.pickModPackagePath).mockResolvedValue("/mods/ui.o2r");
  vi.spyOn(desktopApi, "planLocalModPackage").mockResolvedValue({
    ...localPlan,
    native_id: "ui.o2r",
    needs_code_permission: false,
  });
  const committedSetup = setup("default", "Default", 4, [
    ["hd.o2r", true],
    ["sfx.otr", false],
    ["ui.o2r", true],
    ["retro-hud.otr", true],
  ]);
  const committed: ModSetupView["revision"] = {
    ...committedSetup.revision,
    build: {
      artifact: { asset_name: "test.zip", sha256: "b".repeat(64), size: 1 },
      definition: null,
      install_id: "fixture-install",
      installed_contract_sha256: "c".repeat(64),
      manifest_sha256: "e".repeat(64),
      platform: "windows-x86-64",
      port_id: "shipwright",
      runtime: null,
      selected_executable: "game.exe",
    },
    created_at: 2,
    digest: "d".repeat(64),
    orderings: [],
    originals: [],
    parent_revision: 3,
    save_group: "default",
  };
  const refreshed = view({
    provider: "gamebanana",
    applied_package_count: 4,
    inventory: {
      port_id: "shipwright",
      profiles: [
        {
          ...committedSetup,
          build_availability: "verified",
          profile: {
            ...committedSetup.profile,
            created_at: 1,
            updated_at: 2,
            intent: { update_policy: "keep_current" },
          },
          revision: committed,
        },
      ],
    },
    live: { ...initial.live!, revision: 4 },
  });
  const apply = vi.spyOn(desktopApi, "applyModSetupDraft").mockResolvedValue(committed);
  const host = await render();
  const click = async (label: string) => act(async () => button(host, label).click());
  await click("Browse mods");
  const add = page
    .getByRole("listitem")
    .filter({ hasText: "Retro HUD" })
    .getByRole("button", { name: "Add", exact: true });
  await expect.element(add).toBeVisible();
  await act(async () => (add.element() as HTMLElement).click());
  await click("Installed mods 2");
  await click("Add mod file…");
  await click("Queue file");
  const search = page.getByRole("searchbox", { name: "Search installed mods" });
  const status = page.getByRole("combobox", { name: /Installation status/ });
  const filter = async (name: string) => {
    await act(async () => (status.element() as HTMLElement).click());
    await act(async () =>
      (page.getByRole("option", { name, exact: true }).element() as HTMLElement).click(),
    );
  };
  await filter("Pending changes");
  await search.fill("retro-hud.zip");
  await expect.element(page.getByRole("listitem").filter({ hasText: "Retro HUD" })).toBeVisible();
  expect(host.textContent).not.toContain("No matches on this page");
  await search.fill("ui.o2r");
  await expect.element(page.getByText("ui.o2r", { exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("listitem").filter({ hasText: "Retro HUD" }))
    .not.toBeInTheDocument();
  expect(host.textContent).not.toContain("No matches on this page");
  await filter("Disabled");
  await expect.element(page.getByText("ui.o2r", { exact: true })).not.toBeInTheDocument();
  await expect.element(page.getByText("No matches on this page.")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Installed mods 2" })).toBeVisible();
  await click("Review changes");
  await click("Check files");
  await click("Apply changes");
  await expect.element(page.getByText("Setup changes applied.", { exact: true })).toBeVisible();
  const stale = page.getByText("Portcove couldn’t confirm the current setup. Read setups again.", {
    exact: true,
  });
  await expect.element(stale).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Installed mods 2" }))
    .not.toBeInTheDocument();

  read.mockResolvedValue(refreshed);
  await click("Read setups again");
  await expect.element(page.getByRole("heading", { name: "Setups and mods" })).toHaveFocus();
  await expect.element(page.getByRole("button", { name: "Installed mods 4" })).toBeVisible();
  await expect.element(stale).not.toBeInTheDocument();
  expect(apply).toHaveBeenCalledTimes(1);
});

it("keeps the draft until the exact recovered apply revision is materialized", async () => {
  let standingPass!: () => void;
  vi.spyOn(standingSetup, "onStandingSetupPass").mockImplementation((listener) => {
    standingPass = listener;
    return () => {};
  });
  const library = "recovery-receipt-fixture";
  const stored = `portcove.mod-draft.${JSON.stringify([library, "shipwright", "default"])}.3`;
  const digest = "d".repeat(64);
  const nextView = (materialized: number, revisionDigest = digest) => {
    const next = setup("default", "Default", 4, [
      ["hd.o2r", false],
      ["sfx.otr", false],
    ]);
    return view({
      inventory: {
        port_id: "shipwright",
        profiles: [{ ...next, revision: { ...next.revision, digest: revisionDigest } }],
      } as unknown as NonNullable<ModSetupsView["inventory"]>,
      live: {
        profile_id: "default",
        revision: materialized,
        unmanaged: [],
        changed_owned: [],
        native_list: { state: "in-sync" },
      },
    });
  };
  const read = vi.spyOn(desktopApi, "modSetups").mockResolvedValue(view());
  let rejectApply!: (error: Error) => void;
  const interrupted = new Promise<never>((_, reject) => {
    rejectApply = reject;
  });
  const apply = vi.spyOn(desktopApi, "applyModSetupDraft").mockReturnValue(interrupted);
  vi.spyOn(desktopApi, "useModSetup").mockImplementation(async () => {
    read.mockResolvedValue(nextView(4, "e".repeat(64)));
    return {} as Awaited<ReturnType<typeof desktopApi.useModSetup>>;
  });
  try {
    const host = await render(false, undefined, 7, library);
    const change = page.getByRole("checkbox", { name: "hd.o2r" });
    await act(async () => (change.element() as HTMLElement).click());
    const click = async (label: string) => act(async () => button(host, label).click());
    await click("Review changes");
    await click("Check files");
    await click("Apply changes");
    read.mockResolvedValue(nextView(3));
    await act(async () => standingPass());
    expect(localStorage.getItem(stored)).not.toContain(digest);
    await expect
      .element(page.getByRole("button", { name: "Finish using Default" }))
      .not.toBeInTheDocument();
    await act(async () =>
      rejectApply(
        Object.assign(new Error("Interrupted Apply"), {
          presentation: {
            summary: "Finish applying the setup.",
            technical_message: "The selected setup has an interrupted change.",
            mutation_state: "recovery_required",
            technical_context: { setup_revision: "4", setup_revision_digest: digest },
            recovery_actions: [],
          },
        }),
      ),
    );
    expect(localStorage.getItem(stored)).toContain(digest);
    const finish = page.getByRole("button", { name: "Finish using Default" });
    await expect.element(finish).toBeEnabled();
    await act(async () => (finish.element() as HTMLElement).click());
    expect(localStorage.getItem(stored)).toContain(digest);
    read.mockResolvedValue(nextView(4));
    await act(async () => standingPass());
    await expect.poll(() => localStorage.getItem(stored)).toBeNull();
    expect(apply).toHaveBeenCalledTimes(1);
  } finally {
    localStorage.removeItem(stored);
  }
});

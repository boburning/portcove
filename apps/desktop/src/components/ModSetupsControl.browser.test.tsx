import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { desktopApi } from "../api";
import type { ModSetupsView } from "../types";
import { ModSetupsControl } from "./ModSetupsControl";
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

function setup(id: string, name: string, revision: number, packages: [string, boolean][]) {
  return {
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
  expect(host.textContent).toContain("restores this setup's mods and order");
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
      view({ held_updates: [held("11"), held("12")] }),
    );
    const host = await render();
    expect(host.textContent).toContain("أبقى Portcove الإصدارين الحاليين");
    expect(host.textContent).toContain("the newer file changes which mods it contains");
    expect(host.textContent).toContain("ابحث عن كل تعديل باستخدام «ابحث عن تعديلات في GameBanana»");
  } finally {
    await localization.changeLanguage("en");
  }
});

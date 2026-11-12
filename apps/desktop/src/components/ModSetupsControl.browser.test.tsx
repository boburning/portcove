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

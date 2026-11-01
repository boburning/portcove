import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import type { GameSettingChange, GameSettingReview, GameSettingsView } from "../types";
import { GameSettingsPanel, type GameSettingsActions } from "./GameSettingsPanel";
import { GameSettingsControl } from "./GameSettingsControl";
import { desktopApi } from "../api";
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

function settings(): GameSettingsView {
  return {
    port_id: "shipwright",
    install_id: "retained-install",
    available: true,
    reason: null,
    files: [
      {
        id: "preferences",
        path: "shipofharkinian.json",
        available: true,
        reason: null,
        configuration_sha256: "a".repeat(64),
        settings: [
          {
            id: "master-volume",
            label: "Master volume",
            value: 70,
            value_type: { kind: "integer", minimum: 0, maximum: 100, step: 1, default: 40 },
          },
        ],
      },
    ],
  };
}

function reviewed(change: GameSettingChange): GameSettingReview {
  return {
    port_id: "shipwright",
    install_id: "retained-install",
    file_id: "preferences",
    setting_id: "master-volume",
    label: "Master volume",
    path: "shipofharkinian.json",
    change,
    previous_value: 70,
    proposed_value: change.action === "reset" ? 40 : change.value,
    configuration_sha256: "a".repeat(64),
    review_sha256: "b".repeat(64),
  };
}

async function mount(actions: GameSettingsActions, initial = settings(), replaceOnChange = false) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  let currentGeneration = 1;
  const changed = vi.fn((view: GameSettingsView) => {
    if (replaceOnChange) root.render(panel(view, currentGeneration));
  });
  const panel = (view: GameSettingsView, generation: number) => (
    <GameSettingsPanel view={view} generation={generation} actions={actions} changed={changed} />
  );
  const render = async (view: GameSettingsView, generation = 1) => {
    currentGeneration = generation;
    await act(async () => root.render(panel(view, generation)));
  };
  await render(initial);
  return { host, changed, render };
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((item) => item.textContent === label);
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
}

async function click(label: string) {
  await act(async () => button(label).click());
}

it("requires review and explicit save, then passes Core's exact binding to apply", async () => {
  const review = vi.fn(async (_file: string, _setting: string, change: GameSettingChange) =>
    reviewed(change),
  );
  const apply = vi.fn(async () => settings());
  const { changed } = await mount({ review, apply });
  expect(apply).not.toHaveBeenCalled();
  await click("Review default");
  expect(review).toHaveBeenCalledExactlyOnceWith("preferences", "master-volume", {
    action: "reset",
  });
  expect(apply).not.toHaveBeenCalled();
  expect(document.querySelector("[role=dialog]")?.textContent).toContain("Verified default");
  expect(document.activeElement?.textContent).toBe("Review game setting");
  await click("Save setting");
  expect(apply).toHaveBeenCalledExactlyOnceWith(reviewed({ action: "reset" }));
  expect(changed).toHaveBeenCalledExactlyOnceWith(settings());
});

it.each(["library", "installation", "availability"])(
  "invalidates a pending review after %s changes",
  async (kind) => {
    let resolve: ((value: GameSettingReview) => void) | undefined;
    const review = vi.fn(
      () =>
        new Promise<GameSettingReview>((done) => {
          resolve = done;
        }),
    );
    const apply = vi.fn(async () => settings());
    const { render } = await mount({ review, apply });
    await click("Review default");
    const updated = {
      ...settings(),
      install_id: kind === "installation" ? "other-install" : "retained-install",
      available: kind !== "availability",
    };
    await render(updated, kind === "library" ? 2 : 1);
    await act(async () => resolve?.(reviewed({ action: "reset" })));
    if (kind === "availability") await render(settings());
    expect(document.querySelector("[role=dialog]")).toBeNull();
    expect(apply).not.toHaveBeenCalled();
  },
);

it("rejects a review from another installation without enabling save", async () => {
  const review = vi.fn(async () => ({
    ...reviewed({ action: "reset" }),
    install_id: "other-install",
  }));
  const apply = vi.fn(async () => settings());
  await mount({ review, apply });
  await click("Review default");
  expect(document.querySelector("[role=alert]")?.textContent).toContain("installation changed");
  expect(button("Save setting").disabled).toBe(true);
  expect(apply).not.toHaveBeenCalled();
});

it("retains failed-write consequences and requires a fresh review before another apply", async () => {
  const review = vi.fn(async () => reviewed({ action: "reset" }));
  const apply = vi.fn(async (): Promise<GameSettingsView> => {
    throw new Error("Configuration changed; preserve both copies.");
  });
  const { changed } = await mount({ review, apply });
  await click("Review default");
  await click("Save setting");
  expect(document.querySelector("[role=alert]")?.textContent).toContain("preserve both copies");
  expect(button("Save setting").disabled).toBe(true);
  expect(changed).not.toHaveBeenCalled();
  await click("Review again");
  expect(review).toHaveBeenCalledTimes(2);
  expect(apply).toHaveBeenCalledTimes(1);
});

it("does not publish an old apply response into a newly selected library", async () => {
  let resolve: ((value: GameSettingsView) => void) | undefined;
  const review = vi.fn(async () => reviewed({ action: "reset" }));
  const apply = vi.fn(
    () =>
      new Promise<GameSettingsView>((done) => {
        resolve = done;
      }),
  );
  const { changed, render } = await mount({ review, apply });
  await click("Review default");
  await click("Save setting");
  expect(apply).toHaveBeenCalledTimes(1);
  await render(settings(), 2);
  await act(async () => resolve?.(settings()));
  expect(changed).not.toHaveBeenCalled();
});

it("keeps unsupported settings local and issues no edit requests", async () => {
  const review = vi.fn(async () => reviewed({ action: "reset" }));
  const apply = vi.fn(async () => settings());
  await mount(
    { review, apply },
    {
      ...settings(),
      available: false,
      reason: "This installed release does not offer settings.",
      files: [],
    },
  );
  expect(document.querySelector("[role=status]")?.textContent).toContain("installed release");
  expect(document.querySelectorAll("button")).toHaveLength(0);
  expect(review).not.toHaveBeenCalled();
  expect(apply).not.toHaveBeenCalled();
});

it("restores stable focus after save replaces the configuration and editor", async () => {
  const updated = settings();
  const file = updated.files[0];
  if (!file || !file.settings[0]) throw new Error("Missing controlled setting");
  file.configuration_sha256 = "c".repeat(64);
  file.settings[0].value = 40;
  const actions = {
    review: vi.fn(async () => reviewed({ action: "reset" })),
    apply: vi.fn(async () => updated),
  };
  const { host } = await mount(actions, settings(), true);
  await click("Review default");
  await act(async () => button("Save setting").focus());
  await act(async () => userEvent.keyboard("{Enter}"));
  await expect.poll(() => document.activeElement?.textContent).toBe("Game settings");
  expect(host.querySelector("input")?.value).toBe("40");
  expect(actions.apply).toHaveBeenCalledTimes(1);
});

it("keyboard cancellation returns focus without applying", async () => {
  const actions = {
    review: vi.fn(async () => reviewed({ action: "reset" })),
    apply: vi.fn(async () => settings()),
  };
  await mount(actions);
  await click("Review default");
  await act(async () => userEvent.keyboard("{Escape}"));
  await expect.poll(() => document.activeElement?.textContent).toBe("Game settings");
  expect(actions.apply).not.toHaveBeenCalled();
});

it.each(["shipwright", "diddy-kong-racing-golden-balloon", "decimal-fixture"])(
  "submits typed numeric intent through the same controls for %s",
  async (portId) => {
    const view = settings();
    view.port_id = portId;
    const file = view.files[0];
    if (!file || !file.settings[0]) throw new Error("Missing controlled setting");
    const setting = file.settings[0];
    const value = portId === "decimal-fixture" ? 1.35 : 85;
    if (portId === "diddy-kong-racing-golden-balloon") {
      file.path = "GoldenBalloon/mdkr64.ini";
      setting.value_type = { kind: "integer", minimum: 0, maximum: 100, step: 1, default: 100 };
    }
    if (portId === "decimal-fixture") {
      file.path = "preferences.ini";
      setting.id = "scale";
      setting.label = "Scale";
      setting.value = 1;
      setting.value_type = { kind: "number", minimum: 0.75, maximum: 2, step: 0.05, default: 1 };
    }
    const review = vi.fn(async (_file: string, _setting: string, change: GameSettingChange) => ({
      ...reviewed(change),
      port_id: portId,
      setting_id: setting.id,
      label: setting.label,
      path: file.path,
      previous_value: setting.value,
    }));
    const apply = vi.fn(async () => view);
    const { host } = await mount({ review, apply }, view);
    const input = host.querySelector("input");
    if (!(input instanceof HTMLInputElement)) throw new Error("Missing numeric input");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (!setter) throw new Error("Missing native input setter");
      Reflect.apply(setter, input, [String(value)]);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Review change");
    expect(review).toHaveBeenCalledExactlyOnceWith("preferences", setting.id, {
      action: "set",
      value,
    });
    expect(apply).not.toHaveBeenCalled();
  },
);

it.each(["boolean", "enum"])("preserves the scalar type of %s intent", async (kind) => {
  const view = settings();
  const file = view.files[0];
  if (!file || !file.settings[0]) throw new Error("Missing controlled setting");
  const setting = file.settings[0];
  setting.value = false;
  setting.value_type =
    kind === "boolean"
      ? { kind: "boolean", default: false }
      : {
          kind: "enum",
          default: false,
          choices: [
            { label: "Off", value: false },
            { label: "Automatic", value: "auto" },
          ],
        };
  const review = vi.fn(async (_file: string, _setting: string, change: GameSettingChange) =>
    reviewed(change),
  );
  const apply = vi.fn(async () => view);
  const { host } = await mount({ review, apply }, view);
  await act(async () => {
    if (kind === "boolean") {
      const input = host.querySelector("input");
      if (!(input instanceof HTMLInputElement)) throw new Error("Missing checkbox");
      input.click();
    } else {
      const select = host.querySelector("select");
      if (!(select instanceof HTMLSelectElement)) throw new Error("Missing enum choice");
      select.value = "1";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  await click("Review change");
  expect(review).toHaveBeenCalledExactlyOnceWith("preferences", "master-volume", {
    action: "set",
    value: kind === "boolean" ? true : "auto",
  });
});

it("refuses empty numeric input before review and isolates an unavailable file", async () => {
  const view = settings();
  view.files.push({
    id: "unavailable",
    path: "other.ini",
    available: false,
    reason: "This file is not readable yet.",
    configuration_sha256: null,
    settings: [],
  });
  const review = vi.fn(async () => reviewed({ action: "reset" }));
  const apply = vi.fn(async () => view);
  const { host } = await mount({ review, apply }, view);
  expect(host.textContent).toContain("not readable yet");
  const input = host.querySelector("input");
  if (!(input instanceof HTMLInputElement)) throw new Error("Missing numeric input");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!setter) throw new Error("Missing native input setter");
    Reflect.apply(setter, input, [""]);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Review change");
  expect(host.querySelector("[role=alert]")?.textContent).toContain("finite value");
  expect(review).not.toHaveBeenCalled();
  expect(apply).not.toHaveBeenCalled();
});

it("binds explicit settings reads to the current library and installation", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let resolveOld: ((value: GameSettingsView) => void) | undefined;
  const read = vi
    .spyOn(desktopApi, "gameSettings")
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    )
    .mockResolvedValue(settings());
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () =>
    root.render(
      <GameSettingsControl
        portId="shipwright"
        installId="retained-install"
        generation={1}
        busy={false}
      />,
    ),
  );
  expect(read).not.toHaveBeenCalled();
  await click("Read game settings");
  expect(read).toHaveBeenCalledWith("shipwright", 1);
  await act(async () =>
    root.render(
      <GameSettingsControl
        portId="shipwright"
        installId="new-install"
        generation={2}
        busy={false}
      />,
    ),
  );
  await act(async () => resolveOld?.(settings()));
  expect(host.querySelector("input")).toBeNull();
  expect(host.textContent).toContain("Read game settings");
  await click("Read game settings");
  expect(read).toHaveBeenLastCalledWith("shipwright", 2);
  expect(host.querySelector("[role=alert]")?.textContent).toContain("installation changed");
  expect(host.querySelector("input")).toBeNull();
});

it("retries a failed settings read and preserves a local unavailable reason", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const read = vi
    .spyOn(desktopApi, "gameSettings")
    .mockRejectedValueOnce(new Error("controlled read failure"))
    .mockResolvedValue({
      ...settings(),
      available: false,
      install_id: null,
      reason: "Retained release does not offer settings",
      files: [],
    });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () =>
    root.render(
      <GameSettingsControl
        portId="shipwright"
        installId="retained-install"
        generation={1}
        busy={false}
      />,
    ),
  );
  await click("Read game settings");
  expect(host.querySelector("[role=alert]")?.textContent).toContain("controlled read failure");
  await click("Read settings again");
  expect(read).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain("Retained release does not offer settings");
  expect(host.querySelector("input")).toBeNull();
});

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import type {
  GameSettingChange,
  GameSettingsChangeSetReview,
  GameSettingsChangeSetView,
  GameSettingsEdit,
  GameSettingsView,
} from "../types";
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

function observed(settings: GameSettingsView): GameSettingsChangeSetView {
  return { settings, setup: null, setup_name: null, installed_version: "1.2" };
}

function reviewed(change: GameSettingChange): GameSettingsChangeSetReview {
  return {
    library_id: "library",
    port_id: "shipwright",
    install_id: "retained-install",
    file_id: "preferences",
    path: "shipofharkinian.json",
    configuration_sha256: "a".repeat(64),
    review_sha256: "b".repeat(64),
    setup: null,
    edits: [
      {
        edit: { setting_id: "master-volume", change },
        label: "Master volume",
        previous_value: 70,
        proposed_value: change.action === "reset" ? 40 : change.value,
      },
    ],
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
    <GameSettingsPanel
      view={observed(view)}
      generation={generation}
      actions={actions}
      changed={changed}
    />
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
  const review = vi.fn(async (_file: string, [edit]: GameSettingsEdit[]) => reviewed(edit!.change));
  const apply = vi.fn(async () => settings());
  const { changed } = await mount({ review, apply });
  expect(apply).not.toHaveBeenCalled();
  await click("Use default");
  await click("Review changes");
  expect(review).toHaveBeenCalledExactlyOnceWith("preferences", [
    { setting_id: "master-volume", change: { action: "reset" } },
  ]);
  expect(apply).not.toHaveBeenCalled();
  expect(document.querySelector("[role=dialog]")?.textContent).toContain("Default");
  await expect.poll(() => document.activeElement?.textContent).toBe("Review game settings");
  await click("Save changes");
  expect(apply).toHaveBeenCalledExactlyOnceWith(reviewed({ action: "reset" }));
  expect(changed).toHaveBeenCalledExactlyOnceWith(settings());
});

it.each(["library", "installation", "availability"])(
  "invalidates a pending review after %s changes",
  async (kind) => {
    let resolve: ((value: GameSettingsChangeSetReview) => void) | undefined;
    const review = vi.fn(
      () =>
        new Promise<GameSettingsChangeSetReview>((done) => {
          resolve = done;
        }),
    );
    const apply = vi.fn(async () => settings());
    const { render } = await mount({ review, apply });
    await click("Use default");
    await click("Review changes");
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
  await click("Use default");
  await click("Review changes");
  expect(document.querySelector("[role=alert]")?.textContent).toContain("installation changed");
  expect(button("Save changes").disabled).toBe(true);
  expect(apply).not.toHaveBeenCalled();
});

it("explains a refused read-only review and retains the exact draft for retry", async () => {
  const reason = "settings editing requires an effective medium-integrity token";
  const review = vi
    .fn<GameSettingsActions["review"]>()
    .mockRejectedValueOnce({
      code: "unsupported",
      presentation: {
        summary: "This operation is not supported for the current selection.",
        tone: "error",
        mutation_state: "unknown",
        technical_message: reason,
        technical_context: { game_settings_access: "medium_integrity_required" },
        recovery_actions: [],
      },
    })
    .mockResolvedValue(reviewed({ action: "reset" }));
  const apply = vi.fn(async () => settings());
  await mount({ review, apply });
  await click("Use default");
  await click("Review changes");
  const alert = document.querySelector("[role=alert]");
  expect(alert?.textContent).toContain(
    "Open Portcove from the desktop without administrator privileges",
  );
  expect(alert?.textContent).not.toContain("confirm whether anything changed");
  expect(alert?.querySelector("details")?.textContent).toContain(reason);
  expect(button("Save changes").disabled).toBe(true);
  expect(apply).not.toHaveBeenCalled();

  await click("Review again");
  const edits = [{ setting_id: "master-volume", change: { action: "reset" } }];
  expect(review.mock.calls).toEqual([
    ["preferences", edits],
    ["preferences", edits],
  ]);
  expect(document.querySelector("[role=alert]")).toBeNull();
  expect(button("Save changes").disabled).toBe(false);
  expect(apply).not.toHaveBeenCalled();
});

it("retains failed-write consequences and requires a new read before another apply", async () => {
  const review = vi.fn(async () => reviewed({ action: "reset" }));
  const apply = vi.fn(async (): Promise<GameSettingsView> => {
    throw new Error("Configuration changed; preserve both copies.");
  });
  const { changed } = await mount({ review, apply });
  await click("Use default");
  await click("Review changes");
  await click("Save changes");
  expect(document.querySelector("[role=alert]")?.textContent).toContain("preserve both copies");
  expect(button("Save changes").disabled).toBe(true);
  expect(changed).not.toHaveBeenCalled();
  await click("Cancel");
  expect(button("Review changes").disabled).toBe(true);
  expect(review).toHaveBeenCalledTimes(1);
  expect(apply).toHaveBeenCalledTimes(1);
});

it("shows Core's stale-review explanation after a save it refused before starting", async () => {
  const summary =
    "This settings file changed after you reviewed it, so your changes weren’t saved. Read the settings again, then review your changes.";
  const review = vi.fn(async () => reviewed({ action: "reset" }));
  const apply = vi.fn(async (): Promise<GameSettingsView> => {
    throw Object.assign(new Error("settings review is stale"), {
      code: "conflict",
      presentation: {
        summary,
        tone: "error",
        mutation_state: "not_started",
        technical_message: "settings review is stale; read the configuration and review again",
        technical_context: {},
        recovery_actions: [],
      },
    });
  });
  const { changed } = await mount({ review, apply });
  await click("Use default");
  await click("Review changes");
  await click("Save changes");
  expect(document.querySelector("[role=alert]")?.textContent).toContain(summary);
  expect(button("Save changes").disabled).toBe(true);
  await click("Cancel");
  const statuses = [...document.querySelectorAll("[role=status]")].map(
    (status) => status.textContent,
  );
  expect(statuses).toContain(summary);
  expect(statuses.join(" ")).not.toContain("could not confirm");
  expect(button("Review changes").disabled).toBe(true);
  expect(changed).not.toHaveBeenCalled();
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
  await click("Use default");
  await click("Review changes");
  await click("Save changes");
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
  await click("Use default");
  await click("Review changes");
  await act(async () => button("Save changes").focus());
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
  await click("Use default");
  await click("Review changes");
  await act(async () => userEvent.keyboard("{Escape}"));
  await expect.poll(() => document.activeElement?.textContent).toBe("Review changes");
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
    const review = vi.fn(async (_file: string, [edit]: GameSettingsEdit[]) => ({
      ...reviewed(edit!.change),
      port_id: portId,
      path: file.path,
      edits: [
        {
          edit: edit!,
          label: setting.label,
          previous_value: setting.value,
          proposed_value: value,
        },
      ],
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
    await click("Review changes");
    expect(review).toHaveBeenCalledExactlyOnceWith("preferences", [
      { setting_id: setting.id, change: { action: "set", value } },
    ]);
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
  const review = vi.fn(async (_file: string, [edit]: GameSettingsEdit[]) => reviewed(edit!.change));
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
  await click("Review changes");
  expect(review).toHaveBeenCalledExactlyOnceWith("preferences", [
    {
      setting_id: "master-volume",
      change: { action: "set", value: kind === "boolean" ? true : "auto" },
    },
  ]);
  const dialog = document.querySelector("[role=dialog]")?.querySelector("dl");
  expect(dialog?.textContent).toContain(kind === "boolean" ? "On" : "Automatic");
  expect(dialog?.textContent).not.toContain(kind === "boolean" ? "true" : '"auto"');
  expect(apply).not.toHaveBeenCalled();
});

it("keeps an absent saved value distinct from Off while reviewing a default", async () => {
  const view = settings();
  const setting = view.files[0]?.settings[0];
  if (!setting) throw new Error("Missing setting fixture");
  setting.value = null;
  setting.value_type = { kind: "boolean", default: false };
  const review = vi.fn(async (): Promise<GameSettingsChangeSetReview> => ({
    ...reviewed({ action: "reset" }),
    edits: [
      {
        edit: { setting_id: "master-volume", change: { action: "reset" } },
        label: setting.label,
        previous_value: null,
        proposed_value: false,
      },
    ],
  }));
  const apply = vi.fn(async () => view);
  await mount({ review, apply }, view);
  await click("Use default");
  await click("Review changes");
  const dialog = document.querySelector("[role=dialog]")?.querySelector("dl");
  expect(dialog?.textContent).toContain("Not saved");
  expect(dialog?.textContent).toContain("Off");
  expect(apply).not.toHaveBeenCalled();
});

it.each(["integer", "number"] as const)(
  "explains an unsafe %s value without asking for a listed option",
  async (kind) => {
    const view = settings();
    const setting = view.files[0]?.settings[0];
    if (!setting) throw new Error("Missing setting fixture");
    setting.value_type = { kind, minimum: 0, maximum: 10 ** 16, step: 1, default: 40 };
    const review = vi.fn(async () => reviewed({ action: "reset" }));
    const apply = vi.fn(async () => view);
    const { host } = await mount({ review, apply }, view);
    const input = host.querySelector("input");
    if (!(input instanceof HTMLInputElement)) throw new Error("Missing numeric input");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (!setter) throw new Error("Missing input setter");
      Reflect.apply(setter, input, ["9007199254740992"]);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Review changes");
    expect(host.querySelector("[role=alert]")?.textContent).toBe(
      "This number is too large to save accurately.",
    );
    expect(review).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  },
);

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
  const rangeId = `${input.id}-range`;
  expect(input.getAttribute("aria-describedby")).toBe(rangeId);
  expect(document.getElementById(rangeId)?.textContent).toBe(
    "Whole numbers from 0 to 100, in steps of 1.",
  );
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!setter) throw new Error("Missing native input setter");
    Reflect.apply(setter, input, [""]);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const focusedWithError = vi.fn(() => ({
    invalid: input.getAttribute("aria-invalid"),
    describedBy: input.getAttribute("aria-describedby"),
    message: document.getElementById(`${input.id}-error`)?.textContent,
  }));
  input.addEventListener("focus", focusedWithError, { once: true });
  await click("Review changes");
  const error = host.querySelector("[role=alert]");
  expect(error?.textContent).toContain("whole number");
  expect(input.getAttribute("aria-describedby")).toBe(`${input.id}-error ${rangeId}`);
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(document.getElementById(`${input.id}-error`)).toBe(error);
  expect(document.activeElement).toBe(input);
  expect(focusedWithError).toHaveReturnedWith({
    invalid: "true",
    describedBy: `${input.id}-error ${rangeId}`,
    message: error?.textContent,
  });
  expect(review).not.toHaveBeenCalled();
  expect(apply).not.toHaveBeenCalled();
});

it("binds explicit settings reads to the current library and installation", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let resolveOld: ((value: GameSettingsChangeSetView) => void) | undefined;
  const read = vi
    .spyOn(desktopApi, "gameSettingsChangeSetView")
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    )
    .mockResolvedValue(observed(settings()));
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
  await act(async () => resolveOld?.(observed(settings())));
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
    .spyOn(desktopApi, "gameSettingsChangeSetView")
    .mockRejectedValueOnce(new Error("controlled read failure"))
    .mockResolvedValueOnce(
      observed({
        ...settings(),
        available: false,
        install_id: null,
        reason: "Retained release does not offer settings",
        files: [],
      }),
    )
    .mockResolvedValue(observed(settings()));
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
  await click("Read settings again");
  expect(read).toHaveBeenCalledTimes(3);
  expect(host.querySelector("input")?.value).toBe("70");
});

it("presents the panel and review in the active locale while keeping catalog labels", async () => {
  const { initializeLocalization } = await import("../localization");
  const localization = initializeLocalization(["en-US"]);
  try {
    await localization.changeLanguage("ar-XB");
    const review = vi.fn(async () => ({
      ...reviewed({ action: "reset" }),
      install_id: "other-install",
    }));
    const apply = vi.fn(async () => settings());
    const { host } = await mount({ review, apply });
    expect(host.querySelector("section")?.getAttribute("aria-label")).toBe("إعدادات اللعبة");
    expect(host.querySelector("h3")?.textContent).toBe("إعدادات اللعبة");
    expect(host.textContent).toContain("Master volume");
    expect(host.textContent).toContain("أعداد صحيحة من 0 إلى 100، بخطوات قدرها 1.");
    await click("استخدام الافتراضي");
    await click("مراجعة التغييرات");
    const dialog = document.querySelector("[role=dialog]");
    expect(dialog?.textContent).toContain("مراجعة إعدادات اللعبة");
    expect(document.querySelector("[role=alert]")?.textContent).toContain(
      "تغيّر التثبيت. حدّث الإعدادات وراجعها مرة أخرى.",
    );
    expect(button("حفظ التغييرات").disabled).toBe(true);
    expect(apply).not.toHaveBeenCalled();
  } finally {
    await localization.changeLanguage("en");
  }
});

it("translates validation codes and review labels in the active locale", async () => {
  const { initializeLocalization } = await import("../localization");
  const localization = initializeLocalization(["en-US"]);
  try {
    await localization.changeLanguage("ar-XB");
    const review = vi.fn(async (_file: string, [edit]: GameSettingsEdit[]) =>
      reviewed(edit!.change),
    );
    const apply = vi.fn(async () => settings());
    const { host } = await mount({ review, apply });
    const input = host.querySelector("input");
    if (!(input instanceof HTMLInputElement)) throw new Error("Missing numeric input");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (!setter) throw new Error("Missing input setter");
      Reflect.apply(setter, input, ["1.5"]);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("مراجعة التغييرات");
    expect(host.querySelector("[role=alert]")?.textContent).toBe("أدخل عددًا صحيحًا.");
    expect(review).not.toHaveBeenCalled();
    await click("استخدام الافتراضي");
    await click("مراجعة التغييرات");
    const terms = [
      ...(document.querySelector("[role=dialog] dl")?.querySelectorAll("dt") ?? []),
    ].map((item) => item.textContent);
    expect(terms).toEqual(["القيمة المحفوظة الحالية", "الافتراضي"]);
    expect(button("حفظ التغييرات").disabled).toBe(false);
  } finally {
    await localization.changeLanguage("en");
  }
});

it("reviews two edits for one file and keeps a different file's draft after saving", async () => {
  const view = settings();
  const file = view.files[0]!;
  file.settings.push({
    id: "subtitles",
    label: "Subtitles",
    value: false,
    value_type: { kind: "boolean", default: false },
  });
  view.files.push({
    ...file,
    id: "controller",
    path: "controller.ini",
    settings: [
      {
        id: "rumble",
        label: "Rumble",
        value: false,
        value_type: { kind: "boolean", default: false },
      },
    ],
  });
  const expected = [
    { setting_id: "master-volume", change: { action: "set", value: 85 } },
    { setting_id: "subtitles", change: { action: "set", value: true } },
  ] satisfies GameSettingsEdit[];
  const exactReview: GameSettingsChangeSetReview = {
    ...reviewed(expected[0]!.change),
    edits: [
      { edit: expected[0]!, label: "Master volume", previous_value: 70, proposed_value: 85 },
      { edit: expected[1]!, label: "Subtitles", previous_value: false, proposed_value: true },
    ],
  };
  const updated = structuredClone(view);
  updated.files[0]!.configuration_sha256 = "c".repeat(64);
  updated.files[0]!.settings[0]!.value = 85;
  updated.files[0]!.settings[1]!.value = true;
  const review = vi.fn(async () => exactReview);
  const apply = vi.fn(async () => updated);
  const { host } = await mount({ review, apply }, view, true);
  const [audio, controller] = host.querySelectorAll("form");
  const volume = audio?.querySelector("input[type=number]");
  const subtitles = audio?.querySelector("input[type=checkbox]");
  const rumble = controller?.querySelector("input[type=checkbox]");
  const submit = audio?.querySelector("button[type=submit]");
  if (
    !(volume instanceof HTMLInputElement) ||
    !(subtitles instanceof HTMLInputElement) ||
    !(rumble instanceof HTMLInputElement) ||
    !(submit instanceof HTMLButtonElement)
  ) {
    throw new Error("Missing file editor");
  }
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!setter) throw new Error("Missing native input setter");
    Reflect.apply(setter, volume, ["85"]);
    volume.dispatchEvent(new Event("input", { bubbles: true }));
    subtitles.click();
    rumble.click();
  });
  await act(async () => submit.click());
  expect(review).toHaveBeenCalledExactlyOnceWith("preferences", expected);
  expect(document.querySelector("[role=dialog]")?.textContent).toContain("Subtitles");
  expect(document.querySelector("[role=dialog]")?.textContent).not.toContain("Rumble");
  await click("Save changes");
  expect(apply).toHaveBeenCalledExactlyOnceWith(exactReview);
  expect(rumble.checked).toBe(true);
  expect(controller?.querySelector("button[type=submit]")?.matches(":enabled")).toBe(true);
});

it("holds an edited file across a materialized setup revision change", async () => {
  const settingsView = settings();
  const initial = {
    ...observed(settingsView),
    setup_name: "Weekend setup",
    setup: { id: "profile", revision: 1 },
  };
  const later = { ...initial, setup: { ...initial.setup, revision: 2 } };
  const read = vi
    .spyOn(desktopApi, "gameSettingsChangeSetView")
    .mockResolvedValueOnce(initial)
    .mockResolvedValueOnce(later);
  const review = vi.spyOn(desktopApi, "reviewGameSettingsChangeSet");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () =>
    root.render(
      <GameSettingsControl
        portId="shipwright"
        installId="newer-catalog-install"
        generation={1}
        busy={false}
      />,
    ),
  );
  await click("Read game settings");
  await click("Use default");
  expect(host.querySelector("input")?.value).toBe("40");
  expect(host.textContent).toContain("Setup Weekend setup · Game version 1.2");
  await click("Read settings again");
  expect(read).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain("This draft belongs to an earlier setup or file.");
  expect(host.textContent).toContain("discard this draft and enter your changes again.");
  expect(host.querySelector("input")?.value).toBe("40");
  expect(button("Review changes").matches(":disabled")).toBe(true);
  expect(review).not.toHaveBeenCalled();
  await click("Discard draft");
  expect(host.querySelector("input")?.value).toBe("70");
});

it("restores review of the same draft when a temporarily unavailable file returns", async () => {
  const settingsView = settings();
  const initial = {
    ...observed(settingsView),
    setup_name: "Weekend setup",
    setup: { id: "profile", revision: 1 },
  };
  const unavailable = { ...initial, settings: { ...initial.settings, files: [] } };
  const read = vi
    .spyOn(desktopApi, "gameSettingsChangeSetView")
    .mockResolvedValueOnce(initial)
    .mockResolvedValueOnce(unavailable)
    .mockResolvedValueOnce(initial);
  const review = vi.spyOn(desktopApi, "reviewGameSettingsChangeSet");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () =>
    root.render(
      <GameSettingsControl
        portId="shipwright"
        installId="newer-catalog-install"
        generation={1}
        busy={false}
      />,
    ),
  );
  await click("Read game settings");
  await click("Use default");
  expect(host.querySelector("input")?.value).toBe("40");
  expect(host.textContent).toContain("Setup Weekend setup · Game version 1.2");
  await click("Read settings again");
  expect(read).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain(
    "Read settings again to check for the original setup and file.",
  );
  expect(host.querySelector("input")?.value).toBe("40");
  expect(button("Review changes").matches(":disabled")).toBe(true);
  expect(review).not.toHaveBeenCalled();
  await click("Read settings again");
  expect(read).toHaveBeenCalledTimes(3);
  expect(host.querySelector("input")?.value).toBe("40");
  expect(button("Review changes").matches(":disabled")).toBe(false);
  expect(review).not.toHaveBeenCalled();
});

it("keeps a committed write confirmed through failed readback and refreshes the saved value", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const updated = settings();
  updated.files[0]!.configuration_sha256 = "c".repeat(64);
  updated.files[0]!.settings[0]!.value = 40;
  vi.spyOn(desktopApi, "gameSettingsChangeSetView")
    .mockResolvedValueOnce(observed(settings()))
    .mockRejectedValueOnce(new Error("Failed to read settings again"))
    .mockResolvedValueOnce(
      observed({
        ...settings(),
        files: [
          {
            ...settings().files[0]!,
            available: false,
            configuration_sha256: null,
            reason: "This file is unavailable",
            settings: [],
          },
        ],
      }),
    )
    .mockResolvedValueOnce(observed(updated));
  vi.spyOn(desktopApi, "reviewGameSettingsChangeSet").mockResolvedValue(
    reviewed({ action: "reset" }),
  );
  const apply = vi.spyOn(desktopApi, "applyGameSettingsChangeSet").mockRejectedValue({
    message: "Settings saved; readback failed.",
    presentation: {
      summary: "Settings saved; readback failed.",
      technical_message: "Temporary read failure",
      technical_context: {},
      recovery_actions: [],
      mutation_state: "committed",
      tone: "error",
    },
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
  await click("Use default");
  await click("Review changes");
  await click("Save changes");
  await click("Cancel");
  expect(host.textContent).toContain("Changes saved. Read the settings again");
  expect(button("Review changes").matches(":disabled")).toBe(true);
  await click("Read settings again");
  expect(host.textContent).toContain("Failed to read settings again");
  expect(host.textContent).toContain("Changes saved. Read the settings again");
  await click("Read settings again");
  expect(host.textContent).toContain("This file is unavailable");
  expect(host.textContent).toContain("Changes saved. Read the settings again");
  await click("Read settings again");
  expect(host.textContent).not.toContain("Read the settings again to see the current values.");
  expect(host.querySelector("input")?.value).toBe("40");
  expect(apply).toHaveBeenCalledTimes(1);
});

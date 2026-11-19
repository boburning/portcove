import { controlledAct as act } from "../../test/controlled-react-act";
import { render as renderComponent, cleanup, type RenderResult } from "vitest-browser-react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { onReadyNoticePreferenceChange } from "../features/game-file-discovery/use-standing-setup";
import { ReadyNoticesSetting } from "./ReadyNoticesSetting";

let root: RenderResult;
let container: HTMLDivElement;
beforeEach(async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = await renderComponent(null, { container: document.body.appendChild(container) });
});
afterEach(async () => {
  await cleanup();
  container.remove();
  vi.restoreAllMocks();
});

const checkbox = () => document.body.querySelector<HTMLElement>("[data-slot=checkbox]");
async function show(
  load: (generation: number) => Promise<boolean>,
  save: (enabled: boolean, generation: number) => Promise<boolean>,
  generation = 3,
) {
  await act(async () => {
    await root.rerender(<ReadyNoticesSetting generation={generation} load={load} save={save} />);
  });
}

it("shows what Core stores and writes the player's choice back, then tells notices to reassess", async () => {
  const load = vi.fn().mockResolvedValue(true);
  const save = vi.fn().mockResolvedValue(false);
  const changed = vi.fn();
  const stop = onReadyNoticePreferenceChange(changed);
  await show(load, save);
  expect(load).toHaveBeenCalledWith(3);
  expect(checkbox()?.getAttribute("aria-checked")).toBe("true");
  await act(async () => checkbox()?.click());
  expect(save).toHaveBeenCalledWith(false, 3);
  expect(checkbox()?.getAttribute("aria-checked")).toBe("false");
  expect(changed).toHaveBeenCalledTimes(1);
  stop();
});

it("shows the value Core reports back, not the value that was requested", async () => {
  const load = vi.fn().mockResolvedValue(false);
  const save = vi.fn().mockResolvedValue(false);
  await show(load, save);
  await act(async () => checkbox()?.click());
  expect(save).toHaveBeenCalledWith(true, 3);
  expect(checkbox()?.getAttribute("aria-checked")).toBe("false");
});

it("disables the control until Core has answered and reports a failed read or save", async () => {
  const never = () => new Promise<boolean>(() => undefined);
  await show(never, vi.fn());
  expect(checkbox()?.hasAttribute("data-disabled")).toBe(true);

  await show(vi.fn().mockRejectedValue(new Error("down")), vi.fn(), 4);
  expect(document.body.querySelector("[role=alert]")).not.toBeNull();

  const changed = vi.fn();
  const stop = onReadyNoticePreferenceChange(changed);
  const load = vi.fn().mockResolvedValue(true);
  const save = vi.fn().mockRejectedValue(new Error("locked"));
  await show(load, save, 5);
  await act(async () => checkbox()?.click());
  expect(document.body.querySelector("[role=alert]")).not.toBeNull();
  expect(checkbox()?.getAttribute("aria-checked")).toBe("true");
  // A failed save changed nothing, so nothing is reassessed.
  expect(changed).not.toHaveBeenCalled();
  stop();
});

const labelText = "Tell me when games I chose to hear about are ready";
it("toggles through the label, so the visible text is associated with the checkbox", async () => {
  const save = vi.fn().mockResolvedValue(false);
  await show(vi.fn().mockResolvedValue(true), save);
  const label = [...document.body.querySelectorAll("label")].find((node) =>
    node.textContent?.includes(labelText),
  );
  await act(async () => label?.click());
  expect(save).toHaveBeenCalledWith(false, 3);
});

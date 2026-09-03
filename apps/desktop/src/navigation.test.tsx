// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChoiceMenu } from "./components/ChoiceMenu";
import { useDialogFocus } from "./dialog";
import { focusRegion } from "./focus";
import { useGamepadNavigation } from "./gamepad";

let root: Root;
let buttons: GamepadButton[];
let frames: Map<number, FrameRequestCallback>;
let frameId: number;
let timestamp = 0;

function TestDialog({ close }: { close: () => void }) {
  const dialog = useDialogFocus(close);
  const [choice, setChoice] = useState("notify");
  return <section role="dialog" aria-modal="true" ref={dialog}>
    <button onClick={close}>Close details</button>
    <input aria-label="Source path" />
    <details open><summary>Advanced controls</summary>
      <ChoiceMenu label="Update policy" value={choice} onChange={setChoice} options={[{ value: "notify", label: "Notify me" }, { value: "stage", label: "Download and stage" }]} />
    </details>
  </section>;
}

function NavigationFixture() {
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState("Catalog");
  useGamepadNavigation(() => { if (open) setOpen(false); else focusRegion("sidebar"); });
  return <>
    <aside data-focus-region="sidebar"><nav aria-label="Primary navigation">{["Library", "Catalog"].map((name, index) =>
      <button key={name} data-x="0" data-y={index * 50} aria-current={section === name ? "page" : undefined} onClick={() => setSection(name)}>{name}</button>)}</nav></aside>
    <main data-focus-region="workspace"><button data-x="200" data-y="200" onClick={() => setOpen(true)}>Game card</button></main>
    {open && <TestDialog close={() => setOpen(false)} />}
  </>;
}

function control(text: string) {
  const result = [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === text);
  if (!result) throw new Error(`missing button: ${text}`);
  return result;
}

async function frame(pressed: number[] = [], elapsed = 16) {
  buttons = Array.from({ length: 16 }, (_, index) => ({ pressed: pressed.includes(index), touched: pressed.includes(index), value: pressed.includes(index) ? 1 : 0 }));
  timestamp += elapsed;
  await act(async () => {
    const pending = [...frames.entries()];
    for (const [id, callback] of pending) { frames.delete(id); callback(timestamp); }
  });
}

beforeEach(async () => {
  frames = new Map(); frameId = 0; timestamp = 0; buttons = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
  vi.stubGlobal("navigator", { getGamepads: () => [{ id: "Xbox", index: 0, mapping: "standard", axes: [0, 0], buttons }] });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return new DOMRect(Number(this.dataset.x ?? 500), Number(this.dataset.y ?? 0), 100, 40);
  });
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (this: HTMLElement) {
    return [this.getBoundingClientRect()] as unknown as DOMRectList;
  });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<NavigationFixture />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren(); delete document.documentElement.dataset.inputMode;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("controller and modal integration", () => {
  it("ignores background game input without replaying a held button on return", async () => {
    control("Game card").focus();
    const focused = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    await frame([0]);
    expect(document.querySelectorAll("[role=dialog]")).toHaveLength(0);
    focused.mockReturnValue(true);
    await frame([0]);
    expect(document.querySelectorAll("[role=dialog]")).toHaveLength(0);
    await frame(); await frame([0]);
    expect(document.querySelectorAll("[role=dialog]")).toHaveLength(1);
  });
  it("treats a held A or B as one press across dialog renders and restores the card", async () => {
    const card = control("Game card"); card.focus();
    await frame([0]); await frame([0]); await frame([0]);
    expect(document.querySelectorAll("[role=dialog]")).toHaveLength(1);
    expect(document.activeElement).toBe(control("Close details"));
    expect(document.documentElement.dataset.inputMode).toBe("controller");
    await frame([1]); await frame([1]);
    expect(document.querySelectorAll("[role=dialog]")).toHaveLength(0);
    expect(document.activeElement).toBe(card);
    await frame(); await frame([1]);
    expect(document.activeElement).toBe(control("Catalog"));
  });

  it("returns from the content edge to the sidebar and switches sections with bumpers", async () => {
    const card = control("Game card"); card.focus();
    await frame([14]);
    expect(document.activeElement).toBe(control("Catalog"));
    await frame([15]);
    expect(document.activeElement).toBe(card);
    await frame([4]);
    expect(control("Library").getAttribute("aria-current")).toBe("page");
    await frame([4]);
    expect(control("Library").getAttribute("aria-current")).toBe("page");
  });

  it("traps Tab including summary controls, preserves input arrows, and cancels only the top choice", async () => {
    control("Game card").focus(); await frame([0]); await frame();
    const close = control("Close details");
    await act(async () => { close.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })); });
    const input = document.querySelector("input")!;
    expect(document.activeElement).toBe(input);
    const arrow = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
    input.dispatchEvent(arrow); expect(arrow.defaultPrevented).toBe(false);
    await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })); });
    expect(document.activeElement?.tagName).toBe("SUMMARY");
    const choice = document.querySelector<HTMLButtonElement>("[aria-haspopup=dialog]")!;
    choice.focus(); await frame([0]); await frame();
    expect(document.querySelectorAll("[role=dialog]")).toHaveLength(2);
    expect(document.activeElement).toBe(control("Notify me"));
    await frame([5]);
    expect(control("Catalog").getAttribute("aria-current")).toBe("page");
    await frame([1]); await frame([1]);
    expect(document.querySelectorAll("[role=dialog]")).toHaveLength(1);
    expect(document.activeElement).toBe(choice);
    expect(choice.textContent).toContain("Notify me");
  });
});

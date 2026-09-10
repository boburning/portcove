import { ReleaseChannelControl } from "./components/ReleaseChannel";
import { portStatus } from "./test-fixtures";
// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChoiceMenu } from "./components/ChoiceMenu";
import { ExternalLink } from "./components/ExternalLink";
import { desktopApi } from "./api";
import { useDialogFocus } from "./dialog";
import { activateFocusedControl, focusRegion } from "./focus";
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
  it("activates once without measuring unrelated controls in a large list", async () => {
    const clicked = vi.fn();
    function LargeList() {
      useGamepadNavigation(() => undefined);
      return <main>{Array.from({ length: 1000 }, (_, index) => <button key={index} onClick={clicked}>Game {index}</button>)}</main>;
    }
    await act(async () => root.render(<LargeList />));
    control("Game 500").focus();
    const visibility = vi.mocked(HTMLElement.prototype.getClientRects); visibility.mockClear();
    const geometry = vi.mocked(HTMLElement.prototype.getBoundingClientRect); geometry.mockClear();
    await frame([0]);
    expect(clicked).toHaveBeenCalledOnce();
    expect(visibility).toHaveBeenCalledTimes(1);
    visibility.mockClear(); geometry.mockClear();
    for (let index = 0; index < 30; index++) await frame([0]);
    expect(clicked).toHaveBeenCalledOnce();
    expect(visibility).not.toHaveBeenCalled(); expect(geometry).not.toHaveBeenCalled();
    await frame(); await frame([0]);
    expect(clicked).toHaveBeenCalledTimes(2);
  });

  it("keeps activation inside the top dialog and rechecks disabled or hidden controls", () => {
    const dialog = document.createElement("section");
    dialog.setAttribute("role", "dialog"); dialog.setAttribute("aria-modal", "true");
    const first = document.createElement("button"); const second = document.createElement("button");
    dialog.append(first, second); document.body.append(dialog);
    const clicked = vi.fn(); first.addEventListener("click", clicked); second.addEventListener("click", clicked);
    control("Game card").focus(); activateFocusedControl();
    expect(document.activeElement).toBe(first); expect(clicked).not.toHaveBeenCalled();
    dialog.tabIndex = 0; dialog.focus(); activateFocusedControl();
    expect(document.activeElement).toBe(first); expect(clicked).not.toHaveBeenCalled();
    first.disabled = true; activateFocusedControl();
    expect(document.activeElement).toBe(second); expect(clicked).not.toHaveBeenCalled();
    second.hidden = true; activateFocusedControl();
    expect(clicked).not.toHaveBeenCalled();
    second.hidden = false; second.focus(); activateFocusedControl();
    expect(clicked).toHaveBeenCalledOnce();
  });

  it("measures only the active region for directional input and does no idle layout work", async () => {
    const workspace = document.querySelector('[data-focus-region="workspace"]')!;
    for (let index = 0; index < 1000; index++) workspace.append(document.createElement("button"));
    control("Library").focus();
    const visibility = vi.mocked(HTMLElement.prototype.getClientRects); visibility.mockClear();
    const geometry = vi.mocked(HTMLElement.prototype.getBoundingClientRect); geometry.mockClear();
    await frame([13]);
    expect(document.activeElement).toBe(control("Catalog"));
    expect(visibility).toHaveBeenCalledTimes(2);
    visibility.mockClear(); geometry.mockClear();
    for (let index = 0; index < 5; index++) await frame([13]);
    expect(visibility).not.toHaveBeenCalled(); expect(geometry).not.toHaveBeenCalled();
    await frame();
    for (let index = 0; index < 30; index++) await frame();
    expect(visibility).not.toHaveBeenCalled(); expect(geometry).not.toHaveBeenCalled();
  });

  it("selects a game channel with the controller and restores focus after saving", async () => {
    const save = vi.fn(async () => ({ ...portStatus(), channel: "rolling" as const }));
    function ChannelFixture() {
      useGamepadNavigation(() => undefined);
      return <ReleaseChannelControl channels={["stable", "rolling"]} selected="stable" busy={false} change={save} refresh={async () => ({})} />;
    }
    await act(async () => root.render(<ChannelFixture />));
    const trigger = control("Release channelStable"); trigger.focus();
    await frame([0]); await frame();
    expect(document.activeElement).toBe(control("Stable"));
    await act(async () => { control("Stable").dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })); });
    expect(document.activeElement).toBe(control("Rolling"));
    await frame([0]); await frame();
    expect(save).toHaveBeenCalledExactlyOnceWith("rolling");
    expect(document.querySelector("[role=dialog]")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps focus in a dialog when async work removes or disables the focused control", async () => {
    let transition!: (phase: string) => void;
    function ChangingDialog() {
      const [phase, setPhase] = useState("running"); transition = setPhase;
      const dialog = useDialogFocus(() => undefined);
      return <section role="dialog" aria-modal="true" ref={dialog}>
        <button disabled={phase === "waiting"}>Search again</button>
        {phase === "running" && <button>Cancel preparation</button>}
        <p>{phase}</p>
      </section>;
    }
    await act(async () => root.render(<ChangingDialog />)); await frame();
    control("Cancel preparation").focus();
    await act(async () => transition("waiting")); await frame();
    expect(document.activeElement).toBe(document.querySelector('[role="dialog"]'));
    await act(async () => transition("complete")); await frame();
    expect(document.activeElement).toBe(control("Search again"));
  });

  it("opens external links through the desktop bridge and exposes launch errors", async () => {
    const open = vi.spyOn(desktopApi, "openExternalUrl").mockResolvedValue(undefined);
    await act(async () => root.render(<><NavigationFixture /><ExternalLink href="https://github.com/boburning/portcove">Repository</ExternalLink></>));
    const link = document.querySelector<HTMLAnchorElement>("a")!;
    link.focus(); await frame([0]);
    expect(open).toHaveBeenCalledWith(link.href);
    open.mockRejectedValue({ message: "No browser configured" });
    await act(async () => link.click());
    expect(document.querySelector("[role=alert]")?.textContent).toContain("No browser configured");
  });

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

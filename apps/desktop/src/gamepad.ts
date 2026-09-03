import { useEffect, useRef, useState } from "react";
import { activateControl, cyclePrimaryNavigation, dismissActiveDialog, fieldOwnsArrows, focusAndReveal, focusRegion, focusableControls } from "./focus";

export type NavigationDirection = "up" | "down" | "left" | "right";
export interface FocusRect { left: number; top: number; width: number; height: number }

export function pressedButtons(buttons: readonly GamepadButton[]) {
  return new Set(buttons.flatMap((button, index) => button.pressed ? [index] : []));
}

export function navigationDirection(pad: Gamepad): NavigationDirection | undefined {
  if (pad.buttons[12]?.pressed || pad.axes[1] < -0.65) return "up";
  if (pad.buttons[13]?.pressed || pad.axes[1] > 0.65) return "down";
  if (pad.buttons[14]?.pressed || pad.axes[0] < -0.65) return "left";
  if (pad.buttons[15]?.pressed || pad.axes[0] > 0.65) return "right";
  return undefined;
}

export function keyboardNavigationAction(key: string): NavigationDirection | "back" | undefined {
  if (key === "Escape") return "back";
  const directions: Record<string, NavigationDirection> = {
    ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
  };
  return directions[key];
}

export function spatialTargetIndex(rects: FocusRect[], current: number, direction: NavigationDirection) {
  if (rects.length === 0) return -1;
  if (current < 0 || current >= rects.length) return 0;
  const origin = center(rects[current]);
  let best = -1;
  let bestScore = Number.POSITIVE_INFINITY;
  rects.forEach((rect, index) => {
    if (index === current) return;
    const candidate = center(rect);
    const dx = candidate.x - origin.x;
    const dy = candidate.y - origin.y;
    const primary = direction === "left" ? -dx : direction === "right" ? dx : direction === "up" ? -dy : dy;
    if (primary <= 2) return;
    const secondary = direction === "left" || direction === "right" ? Math.abs(dy) : Math.abs(dx);
    const score = primary + secondary * 2.5 + Math.hypot(dx, dy) * 0.05;
    if (score < bestScore) {
      best = index;
      bestScore = score;
    }
  });
  return best;
}

/** Button edges and repeat timing belong to the controller session, not a render. */
class ControllerInput {
  private previous = new Set<number>();
  private identity = "";
  private previousDirection: NavigationDirection | undefined;
  private nextMoveAt = 0;

  sample(pad: Gamepad | undefined, timestamp: number) {
    const identity = pad ? `${pad.index}:${pad.id}` : "";
    const connectionChanged = identity !== this.identity;
    if (connectionChanged) { this.previous.clear(); this.previousDirection = undefined; this.identity = identity; }
    const pressed = pad ? pressedButtons(pad.buttons) : new Set<number>();
    const buttons = new Set([...pressed].filter(button => !this.previous.has(button)));
    const direction = pad ? navigationDirection(pad) : undefined;
    const move = direction && (direction !== this.previousDirection || timestamp >= this.nextMoveAt) ? direction : undefined;
    if (move) this.nextMoveAt = timestamp + (direction !== this.previousDirection ? 350 : 140);
    this.previousDirection = direction;
    this.previous = pressed;
    return { connectionChanged, buttons, move, active: Boolean(direction || pressed.size) };
  }
}

function controllerButton(buttons: Set<number>, back: () => void) {
  if (buttons.has(1)) {
    if (!dismissActiveDialog()) back();
  } else if (buttons.has(0)) {
    const items = focusableControls();
    const focused = items.find(item => item === document.activeElement);
    if (focused) activateControl(focused);
    else focusAndReveal(items[0]);
  } else if (buttons.has(4)) cyclePrimaryNavigation(-1);
  else if (buttons.has(5)) cyclePrimaryNavigation(1);
}

export function useGamepadNavigation(onBack: () => void) {
  const [controller, setController] = useState<string>();
  const back = useRef(onBack);
  back.current = onBack;
  useEffect(() => {
    let frame = 0;
    const input = new ControllerInput();
    const poll = (timestamp: number) => {
      const pad = Array.from(navigator.getGamepads()).find(Boolean);
      const state = input.sample(pad ?? undefined, timestamp);
      if (state.connectionChanged) setController(pad ? "Controller connected" : undefined);
      frame = requestAnimationFrame(poll);
      // Games and native file pickers must own their controller input while
      // Portcove is in the background. Still consume edges to avoid replay.
      if (!document.hasFocus()) return;
      if (state.active) document.documentElement.dataset.inputMode = "controller";
      if (state.move) {
        const items = focusableControls();
        moveFocus(items, items.indexOf(document.activeElement as HTMLElement), state.move);
      }
      controllerButton(state.buttons, () => back.current());
    };
    const keydown = (event: KeyboardEvent) => {
      document.documentElement.dataset.inputMode = "keyboard";
      if (event.defaultPrevented || event.isComposing) return;
      const action = keyboardNavigationAction(event.key);
      if (action === "back") {
        back.current();
        event.preventDefault();
        return;
      }
      const direction = action;
      if (!direction || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target as HTMLElement | null;
      if (fieldOwnsArrows(target)) return;
      const items = focusableControls();
      if (moveFocus(items, items.indexOf(document.activeElement as HTMLElement), direction)) event.preventDefault();
    };
    const pointerdown = () => { document.documentElement.dataset.inputMode = "pointer"; };
    window.addEventListener("keydown", keydown);
    window.addEventListener("pointerdown", pointerdown);
    frame = requestAnimationFrame(poll);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("pointerdown", pointerdown);
    };
  }, []);
  return controller;
}

function moveFocus(items: HTMLElement[], current: number, direction: NavigationDirection) {
  const origin = items[current];
  const region = origin?.closest<HTMLElement>("[data-focus-region]");
  const horizontal = direction === "left" || direction === "right";
  const rect = origin?.getBoundingClientRect();
  const candidates = region ? items.filter(item => {
    if (item.closest("[data-focus-region]") !== region) return false;
    const candidate = item.getBoundingClientRect();
    return !horizontal || !rect || (candidate.top < rect.bottom && candidate.bottom > rect.top);
  }) : items;
  const target = spatialTargetIndex(candidates.map(item => item.getBoundingClientRect()), candidates.indexOf(origin), direction);
  if (target < 0 && horizontal && region) {
    if (direction === "left" && region.dataset.focusRegion === "workspace") return focusRegion("sidebar");
    if (direction === "right" && region.dataset.focusRegion === "sidebar") return focusRegion("workspace");
  }
  if (target < 0) return false;
  focusAndReveal(candidates[target]);
  return true;
}

function center(rect: FocusRect) {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

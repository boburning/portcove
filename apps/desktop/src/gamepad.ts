import { useEffect, useEffectEvent, useState } from "react";
import {
  activateFocusedControl,
  cyclePrimaryNavigation,
  dismissActiveDialog,
  fieldOwnsArrows,
  focusAndReveal,
  focusRegion,
  focusableControls,
  navigationScope,
} from "./focus";

export type NavigationDirection = "up" | "down" | "left" | "right";
export interface FocusRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function recordKeyboardInput() {
  document.documentElement.dataset.inputMode = "keyboard";
}

export function pressedButtons(buttons: readonly GamepadButton[]) {
  return new Set(buttons.flatMap((button, index) => (button.pressed ? [index] : [])));
}

export function navigationDirection(pad: Gamepad): NavigationDirection | undefined {
  const horizontal = pad.axes[0] ?? 0;
  const vertical = pad.axes[1] ?? 0;
  if (pad.buttons[12]?.pressed || vertical < -0.65) return "up";
  if (pad.buttons[13]?.pressed || vertical > 0.65) return "down";
  if (pad.buttons[14]?.pressed || horizontal < -0.65) return "left";
  if (pad.buttons[15]?.pressed || horizontal > 0.65) return "right";
  return undefined;
}

export function keyboardNavigationAction(key: string): NavigationDirection | "back" | undefined {
  if (key === "Escape") return "back";
  const directions: Record<string, NavigationDirection> = {
    ArrowUp: "up",
    ArrowDown: "down",
    ArrowLeft: "left",
    ArrowRight: "right",
  };
  return Object.hasOwn(directions, key) ? directions[key] : undefined;
}

export function spatialTargetIndex(
  rects: FocusRect[],
  current: number,
  direction: NavigationDirection,
  groups: readonly unknown[] = [],
) {
  if (rects.length === 0) return -1;
  if (current < 0 || current >= rects.length) return 0;
  const origin = rects[current];
  if (!origin) return 0;
  const vertical = direction === "up" || direction === "down";
  const candidates = rects
    .map((rect, index) => ({
      index,
      rect,
      distance: directionalGap(origin, rect, direction),
    }))
    .filter(
      (item) =>
        item.index !== current &&
        item.distance >= -1 &&
        (vertical || overlapsRow(origin, item.rect)),
    );
  if (candidates.length === 0) return -1;
  const nearest = Math.min(...candidates.map((item) => item.distance));
  // Visit the nearest visual row/column before considering alignment. A short
  // filter row must never lose to a large card farther down the page.
  const band = candidates.filter((item) => item.distance <= nearest + 3);
  const enteringGroup =
    vertical && groups.length > 0 && band.every((item) => groups[item.index] !== groups[current]);
  const crossDistance = (rect: FocusRect) =>
    vertical
      ? Math.abs(center(rect).x - center(origin).x)
      : Math.abs(center(rect).y - center(origin).y);
  band.sort((a, b) =>
    enteringGroup ? a.rect.left - b.rect.left : crossDistance(a.rect) - crossDistance(b.rect),
  );
  return band[0]?.index ?? -1;
}

function overlapsRow(origin: FocusRect, candidate: FocusRect) {
  return (
    candidate.top < origin.top + origin.height && candidate.top + candidate.height > origin.top
  );
}

function directionalGap(origin: FocusRect, candidate: FocusRect, direction: NavigationDirection) {
  const gap =
    direction === "down"
      ? candidate.top - (origin.top + origin.height)
      : direction === "up"
        ? origin.top - (candidate.top + candidate.height)
        : direction === "right"
          ? candidate.left - (origin.left + origin.width)
          : origin.left - (candidate.left + candidate.width);
  // A card and its sibling Favorite can have contained hit regions. Edge-only
  // scoring otherwise makes the smaller control unreachable from every side.
  const contains = (outer: FocusRect, inner: FocusRect) =>
    outer.left <= inner.left &&
    outer.top <= inner.top &&
    outer.left + outer.width >= inner.left + inner.width &&
    outer.top + outer.height >= inner.top + inner.height;
  if (gap < -1 && (contains(origin, candidate) || contains(candidate, origin))) {
    const a = center(origin);
    const b = center(candidate);
    const toward =
      direction === "down"
        ? b.y - a.y
        : direction === "up"
          ? a.y - b.y
          : direction === "right"
            ? b.x - a.x
            : a.x - b.x;
    if (toward > 0) return 0;
  }
  return gap;
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
    if (connectionChanged) {
      this.previous.clear();
      this.previousDirection = undefined;
      this.identity = identity;
    }
    const pressed = pad ? pressedButtons(pad.buttons) : new Set<number>();
    const buttons = new Set([...pressed].filter((button) => !this.previous.has(button)));
    const direction = pad ? navigationDirection(pad) : undefined;
    const move =
      direction && (direction !== this.previousDirection || timestamp >= this.nextMoveAt)
        ? direction
        : undefined;
    if (move) this.nextMoveAt = timestamp + (direction !== this.previousDirection ? 350 : 140);
    this.previousDirection = direction;
    this.previous = pressed;
    return {
      connectionChanged,
      buttons,
      move,
      active: Boolean(direction || pressed.size),
    };
  }
}

// Editable comboboxes use virtual focus: their options must not take DOM focus.
// Opt in only the maintained SearchChoice; command palette and Select retain
// their existing controller contracts.
function controllerCombobox() {
  const input = document.activeElement;
  return input instanceof HTMLInputElement &&
    input.matches('[data-controller-combobox][role="combobox"]') &&
    !input.disabled &&
    !input.readOnly
    ? input
    : undefined;
}

function controllerComboboxKey(input: HTMLInputElement, key: string) {
  input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  // The shared keyboard capture records this synthetic event synchronously.
  document.documentElement.dataset.inputMode = "controller";
}

function controllerButton(
  buttons: Set<number>,
  back: () => void,
  navigate: (offset: number) => void,
) {
  if (buttons.has(1)) {
    if (!dismissActiveDialog()) back();
  } else if (buttons.has(0)) {
    const input = controllerCombobox();
    if (input)
      controllerComboboxKey(
        input,
        input.getAttribute("aria-expanded") === "true" ? "Enter" : "ArrowDown",
      );
    else activateFocusedControl();
  } else if (buttons.has(4)) cyclePrimaryNavigation(-1, navigate);
  else if (buttons.has(5)) cyclePrimaryNavigation(1, navigate);
}

export function useGamepadNavigation(onBack: () => void, onNavigate?: (offset: number) => void) {
  const [controller, setController] = useState<string>();
  const back = useEffectEvent(onBack);
  const navigate = useEffectEvent((offset: number) => onNavigate?.(offset));
  useEffect(() => {
    let frame = 0;
    const input = new ControllerInput();
    const poll = (timestamp: number) => {
      const pad = Array.from(navigator.getGamepads?.() ?? []).find(Boolean);
      const state = input.sample(pad ?? undefined, timestamp);
      if (state.connectionChanged) setController(pad ? "Controller connected" : undefined);
      frame = requestAnimationFrame(poll);
      // Games and native file pickers must own their controller input while
      // Portcove is in the background. Still consume edges to avoid replay.
      if (!document.hasFocus()) return;
      if (state.active && document.documentElement.dataset.inputMode !== "controller")
        document.documentElement.dataset.inputMode = "controller";
      if (state.move) {
        const input = controllerCombobox();
        if (input?.getAttribute("aria-expanded") === "true") {
          const key = { up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight" }[
            state.move
          ];
          controllerComboboxKey(input, key);
        } else moveFocus(state.move);
      }
      controllerButton(state.buttons, back, navigate);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const action = keyboardNavigationAction(event.key);
      if (action === "back") {
        // The top dialog or portaled selector owns its Escape before the
        // workspace Back action. Its own handler will prevent the event.
        if (navigationScope() !== document) return;
        back();
        event.preventDefault();
        return;
      }
      const direction = action;
      if (!direction || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target as HTMLElement | null;
      if (fieldOwnsArrows(target)) return;
      if (moveFocus(direction)) event.preventDefault();
    };
    const pointerdown = () => {
      document.documentElement.dataset.inputMode = "pointer";
    };
    window.addEventListener("keydown", recordKeyboardInput, true);
    window.addEventListener("keydown", keydown);
    window.addEventListener("pointerdown", pointerdown);
    frame = requestAnimationFrame(poll);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", recordKeyboardInput, true);
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("pointerdown", pointerdown);
    };
  }, []);
  return controller;
}

function moveFocus(direction: NavigationDirection) {
  const scope = navigationScope();
  const origin = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  const containingRegion = origin?.closest<HTMLElement>("[data-focus-region]");
  const region =
    containingRegion && scope.contains(containingRegion) ? containingRegion : undefined;
  const horizontal = direction === "left" || direction === "right";
  const candidates = focusableControls(region ?? scope).filter(
    (item) => !region || item.closest("[data-focus-region]") === region,
  );
  // A section heading can receive programmatic focus without joining the Tab
  // order. Keep its position as the arrow origin instead of jumping to index 0.
  if (
    origin &&
    !candidates.includes(origin) &&
    (region ?? scope).contains(origin) &&
    origin.matches("[tabindex]") &&
    !origin.closest("[inert], [hidden], [aria-hidden=true]") &&
    origin.getClientRects().length > 0 &&
    getComputedStyle(origin).visibility !== "hidden"
  ) {
    // Enter the section that owns a focused heading before considering sticky
    // navigation that may now sit geometrically between it and its controls.
    const section = origin.closest<HTMLElement>(
      "section[aria-labelledby], article[aria-labelledby], [role=region][aria-labelledby]",
    );
    if (
      direction === "down" &&
      origin.matches('h1, h2, h3, h4, h5, h6, [role="heading"]') &&
      origin.id &&
      section?.getAttribute("aria-labelledby")?.split(/\s+/).includes(origin.id)
    ) {
      const first = candidates.find((item) => section.contains(item));
      if (first) {
        focusAndReveal(first);
        return true;
      }
    }
    candidates.unshift(origin);
  }
  const target = spatialTargetIndex(
    candidates.map((item) => item.getBoundingClientRect()),
    origin ? candidates.indexOf(origin) : -1,
    direction,
    candidates.map((item) => item.closest("[data-focus-group]")),
  );
  if (target < 0 && horizontal && region) {
    if (direction === "left" && region.dataset.focusRegion === "workspace")
      return focusRegion("sidebar");
    if (direction === "right" && region.dataset.focusRegion === "sidebar")
      return focusRegion("workspace");
  }
  if (target < 0) return false;
  focusAndReveal(candidates[target]);
  return true;
}

function center(rect: FocusRect) {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

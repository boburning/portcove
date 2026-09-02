import { useEffect } from "react";

export type NavigationDirection = "up" | "down" | "left" | "right";
export interface FocusRect { left: number; top: number; width: number; height: number }

const focusables = () => Array.from(document.querySelectorAll<HTMLElement>("[data-focusable]:not([disabled])"))
  .filter(item => item.getClientRects().length > 0);

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

export function useGamepadNavigation(onBack: () => void) {
  useEffect(() => {
    let frame = 0;
    let previous = new Set<number>();
    let lastMove = 0;
    const poll = (timestamp: number) => {
      const pad = Array.from(navigator.getGamepads()).find(Boolean);
      if (pad) {
        const pressed = pressedButtons(pad.buttons);
        const items = focusables();
        const focused = items.indexOf(document.activeElement as HTMLElement);
        const direction = navigationDirection(pad);
        if (direction && timestamp - lastMove >= 140) {
          lastMove = timestamp;
          moveFocus(items, focused, direction);
        }
        if (pressed.has(0) && !previous.has(0)) (document.activeElement as HTMLElement | null)?.click();
        if (pressed.has(1) && !previous.has(1)) onBack();
        previous = pressed;
      }
      frame = requestAnimationFrame(poll);
    };
    const keydown = (event: KeyboardEvent) => {
      const action = keyboardNavigationAction(event.key);
      if (action === "back") {
        onBack();
        event.preventDefault();
        return;
      }
      const direction = action;
      if (!direction || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select")) return;
      const items = focusables();
      if (moveFocus(items, items.indexOf(document.activeElement as HTMLElement), direction)) event.preventDefault();
    };
    window.addEventListener("keydown", keydown);
    frame = requestAnimationFrame(poll);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", keydown);
    };
  }, [onBack]);
}

function moveFocus(items: HTMLElement[], current: number, direction: NavigationDirection) {
  const target = spatialTargetIndex(items.map(item => item.getBoundingClientRect()), current, direction);
  if (target < 0) return false;
  items[target]?.focus();
  items[target]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  return true;
}

function center(rect: FocusRect) {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

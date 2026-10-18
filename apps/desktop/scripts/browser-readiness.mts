/** Browser-only probes serialized verbatim by Selenium; keep bodies self-contained. */
export interface GamepadCapabilityObservation {
  outcome:
    | "api-absent"
    | "api-access-failed-or-restricted"
    | "devices-exposed"
    | "no-exposed-device";
  exposed_devices: number | null;
}

export function observeGamepadCapability(): GamepadCapabilityObservation {
  try {
    if (typeof globalThis.navigator.getGamepads !== "function")
      return { outcome: "api-absent", exposed_devices: 0 };
    const devices = Array.from(globalThis.navigator.getGamepads()).filter(Boolean);
    return {
      outcome: devices.length ? "devices-exposed" : "no-exposed-device",
      exposed_devices: devices.length,
    };
  } catch {
    return { outcome: "api-access-failed-or-restricted", exposed_devices: null };
  }
}

export function observeVisibleTarget(selector: string, policy: "semantic" | "visual" = "semantic") {
  const elements = Array.from(globalThis.document.querySelectorAll(selector));
  const target = elements.length === 1 ? elements[0] : null;
  const rect = target?.getBoundingClientRect();
  const style = target ? globalThis.getComputedStyle(target) : null;
  const viewport = {
    width: globalThis.innerWidth,
    height: globalThis.innerHeight,
    device_pixel_ratio: globalThis.devicePixelRatio,
  };
  // Capture completeness concerns rendered pixels, including decorative aria-hidden art.
  // Keep the existing semantic readiness policy unchanged for other consumers.
  let visuallyComplete = true;
  const clipping: { element: string; axis: string; edge: number; limit: number }[] = [];
  if (policy === "visual" && target && rect) {
    for (let ancestor: Element | null = target; ancestor; ancestor = ancestor.parentElement) {
      const computed = globalThis.getComputedStyle(ancestor);
      if (
        computed.display === "none" ||
        computed.visibility !== "visible" ||
        Number(computed.opacity) === 0
      )
        visuallyComplete = false;
      const rootStyle = globalThis.getComputedStyle(globalThis.document.documentElement);
      const viewportOverflow =
        ancestor === globalThis.document.documentElement ||
        (ancestor === globalThis.document.body &&
          rootStyle.overflowX === "visible" &&
          rootStyle.overflowY === "visible");
      if (ancestor !== target && !viewportOverflow) {
        const box = ancestor.getBoundingClientRect();
        const borderLeft = Number.parseFloat(computed.borderLeftWidth) || 0;
        const borderRight = Number.parseFloat(computed.borderRightWidth) || 0;
        const borderTop = Number.parseFloat(computed.borderTopWidth) || 0;
        const borderBottom = Number.parseFloat(computed.borderBottomWidth) || 0;
        const left = box.left + borderLeft;
        const top = box.top + borderTop;
        // client dimensions are integer-rounded; retain fractional padding edges.
        const right =
          box.right -
          borderRight -
          Math.max(0, Math.round(box.width - borderLeft - borderRight) - ancestor.clientWidth);
        const bottom =
          box.bottom -
          borderBottom -
          Math.max(0, Math.round(box.height - borderTop - borderBottom) - ancestor.clientHeight);
        if (
          /^(hidden|clip|auto|scroll)$/.test(computed.overflowX) &&
          (rect.left < left || rect.right > right)
        ) {
          visuallyComplete = false;
          clipping.push({
            element: ancestor.tagName + "." + ancestor.className,
            axis: "x",
            edge: rect.right,
            limit: right,
          });
        }
        if (
          /^(hidden|clip|auto|scroll)$/.test(computed.overflowY) &&
          (rect.top < top || rect.bottom > bottom)
        ) {
          visuallyComplete = false;
          clipping.push({
            element: ancestor.tagName + "." + ancestor.className,
            axis: "y",
            edge: rect.bottom,
            limit: bottom,
          });
        }
      }
    }
  }
  return {
    ...(policy === "visual" ? { clipping } : {}),
    viewport,
    application_state: {
      document_ready: globalThis.document.readyState,
      loading: globalThis.document.querySelectorAll(".loading-state").length,
    },
    target: selector,
    target_count: elements.length,
    rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
    visible: Boolean(
      target &&
      style &&
      rect &&
      !target.closest(
        policy === "visual" ? "[hidden],[inert]" : '[hidden],[inert],[aria-hidden="true"]',
      ) &&
      visuallyComplete &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity) !== 0 &&
      rect.width > 0 &&
      rect.height > 0 &&
      rect.right > 0 &&
      rect.bottom > 0 &&
      rect.left < globalThis.innerWidth &&
      rect.top < globalThis.innerHeight,
    ),
  };
}

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

export function observeVisibleTarget(selector: string) {
  const elements = Array.from(globalThis.document.querySelectorAll(selector));
  const target = elements.length === 1 ? elements[0] : null;
  const rect = target?.getBoundingClientRect();
  const style = target ? globalThis.getComputedStyle(target) : null;
  const viewport = {
    width: globalThis.innerWidth,
    height: globalThis.innerHeight,
    device_pixel_ratio: globalThis.devicePixelRatio,
  };
  return {
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
      !target.closest('[hidden],[inert],[aria-hidden="true"]') &&
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

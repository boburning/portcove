import { writeFile, link, unlink } from "node:fs/promises";
import path from "node:path";
import { fileIdentity } from "./development-evidence.mjs";

// Serializable in the actual WebView; do not import host state into this probe.
export function observeGamepadCapability() {
  try {
    if (typeof navigator.getGamepads !== "function")
      return { outcome: "api-absent", exposed_devices: 0 };
    const devices = Array.from(navigator.getGamepads()).filter(Boolean);
    return {
      outcome: devices.length ? "devices-exposed" : "no-exposed-device",
      exposed_devices: devices.length,
    };
  } catch {
    return { outcome: "api-access-failed-or-restricted", exposed_devices: null };
  }
}

export function capabilityRequirement(observation, requirement) {
  if (
    !["declared-api-fallback", "injected-controller", "physical-controller"].includes(requirement)
  )
    throw new Error("Unknown controller requirement");
  if (requirement === "declared-api-fallback")
    return {
      outcome: ["api-absent", "api-access-failed-or-restricted", "no-exposed-device"].includes(
        observation.outcome,
      )
        ? "passed"
        : "unsupported",
      claim: "declared absence fallback only",
    };
  return {
    outcome: "unsupported",
    claim:
      requirement === "physical-controller"
        ? "Exposed devices alone do not establish physical observations"
        : "Requires actual injected-controller behavior",
  };
}

export function observeVisibleTarget(selector) {
  const elements = Array.from(document.querySelectorAll(selector));
  const target = elements.length === 1 ? elements[0] : null;
  const rect = target?.getBoundingClientRect();
  const style = target ? getComputedStyle(target) : null;
  const viewport = { width: innerWidth, height: innerHeight, device_pixel_ratio: devicePixelRatio };
  return {
    viewport,
    application_state: {
      document_ready: document.readyState,
      loading: document.querySelectorAll(".loading-state").length,
    },
    target: selector,
    target_count: elements.length,
    rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
    visible: Boolean(
      target &&
      !target.closest('[hidden],[inert],[aria-hidden="true"]') &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity) !== 0 &&
      rect.width > 0 &&
      rect.height > 0 &&
      rect.right > 0 &&
      rect.bottom > 0 &&
      rect.left < innerWidth &&
      rect.top < innerHeight,
    ),
  };
}

export async function captureSettledVisual({
  browser,
  output,
  name,
  scenario,
  target,
  readiness,
  timeoutMs = 5000,
  write = writeFile,
}) {
  if (
    !scenario ||
    !target ||
    typeof readiness !== "function" ||
    !/^[a-z0-9-]+$/u.test(name) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30_000
  )
    throw new Error("Settled capture requires a bounded caller-specific contract");
  const end = Date.now() + timeoutMs;
  const observations = [];
  let image;
  async function writeJoined(file, bytes) {
    const remaining = end - Date.now();
    if (remaining <= 0) throw new Error("Settled capture timed out");
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("Settled capture timed out")),
      remaining,
    );
    try {
      // Cancellation requests stop work; they never substitute for joining it.
      await write(file, bytes, { flag: "wx", signal: controller.signal });
      if (controller.signal.aborted || Date.now() >= end)
        throw new Error("Settled capture timed out");
    } finally {
      clearTimeout(timer);
    }
  }
  async function bounded(operation) {
    const remaining = end - Date.now();
    if (remaining <= 0) throw new Error("Settled capture timed out");
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Settled capture timed out")), remaining);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async function observe() {
    const semantic = await bounded(readiness);
    const state = await bounded(() => browser.executeScript(observeVisibleTarget, target));
    const value = { semantic, state };
    observations.push(value);
    if (observations.length > 16) observations.shift();
    return value;
  }
  const ready = (value) =>
    value.semantic?.ready === true &&
    value.state.visible &&
    value.state.viewport.width > 0 &&
    value.state.viewport.height > 0 &&
    value.state.application_state.document_ready === "complete" &&
    value.state.application_state.loading === 0;
  try {
    let before;
    do {
      before = await observe();
      if (ready(before)) break;
      await bounded(() => new Promise((resolve) => setTimeout(resolve, 50)));
    } while (true);
    const bytes = Buffer.from(await bounded(() => browser.takeScreenshot()), "base64");
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      throw new Error("Screenshot is not PNG evidence");
    const after = await observe();
    if (!ready(after) || JSON.stringify(before) !== JSON.stringify(after))
      throw new Error("Application state changed during capture");
    image = path.join(output, `${name}.png`);
    await writeJoined(image, bytes);
    const identity = await bounded(() => fileIdentity(image));
    const receipt = path.join(output, `${name}-capture.json`);
    const record = {
      format_version: 1,
      outcome: "captured",
      scenario,
      image: identity,
      observation: after,
    };
    const staging = path.join(output, `${name}-capture.partial`);
    await writeJoined(staging, JSON.stringify(record, null, 2) + "\n");
    if (Date.now() >= end) throw new Error("Settled capture timed out");
    await link(staging, receipt); // no-clobber publication; await its actual result
    if (Date.now() >= end) {
      await unlink(receipt); // only our just-created link; retain staging and image
      throw new Error("Settled capture timed out");
    }
    await unlink(staging);
    return { ...record, receipt };
  } catch (error) {
    const diagnostic = path.join(output, `${name}-capture-failure.json`);
    await writeFile(
      diagnostic,
      JSON.stringify(
        {
          format_version: 1,
          outcome: "failed",
          scenario,
          target,
          message: error.message,
          observations,
          partial_image: image ?? null,
          acceptance: false,
        },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    ).catch(() => {});
    throw new Error(`${error.message}; capture diagnostics ${diagnostic}`, { cause: error });
  }
}

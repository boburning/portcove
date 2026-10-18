/** Test-only geometry contract, shared by browser and native capture adapters. */
export interface CaptureTargetObservation {
  target: string;
  target_count: number;
  visible: boolean;
  rect: { x: number; y: number; width: number; height: number } | null;
  viewport: { width: number; height: number; device_pixel_ratio?: number };
}

export function requireCompleteCaptureTarget(state: CaptureTargetObservation, target: string) {
  if (state.target !== target || state.target_count !== 1 || !state.rect)
    throw new Error("Capture requires one identified visible target");
  const { rect, viewport } = state;
  if (
    ![rect.x, rect.y, rect.width, rect.height, viewport.width, viewport.height].every(
      Number.isFinite,
    ) ||
    rect.width <= 0 ||
    rect.height <= 0 ||
    viewport.width <= 0 ||
    viewport.height <= 0
  )
    throw new Error("Capture target geometry must be finite and nonzero");
  if (rect.width > viewport.width || rect.height > viewport.height)
    throw new Error("Capture target exceeds viewport; capture identified title/actions instead");
  if (!state.visible) throw new Error("Capture requires one identified visible target");
  if (
    rect.x < 0 ||
    rect.y < 0 ||
    rect.x + rect.width > viewport.width ||
    rect.y + rect.height > viewport.height
  )
    throw new Error("Capture target must be fully inside the viewport");
  return state;
}

export async function prepareCaptureTarget<State extends CaptureTargetObservation>({
  target,
  label,
  scroll,
  observe,
  settle = () => new Promise<void>((resolve) => globalThis.setTimeout(resolve, 50)),
  timeoutMs = 1500,
}: {
  target: string;
  label: string;
  scroll(this: void): void | Promise<unknown>;
  observe(this: void): State | Promise<State>;
  settle?(this: void): Promise<unknown>;
  timeoutMs?: number;
}) {
  if (!target || !label || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000)
    throw new Error("Capture preflight requires a bounded identified target");
  const end = Date.now() + timeoutMs;
  const bounded = async <T>(action: () => T | Promise<T>): Promise<T> => {
    const remaining = end - Date.now();
    if (remaining <= 0) throw new Error("Capture target did not settle before its deadline");
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(action),
        new Promise<never>((_, reject) => {
          timer = globalThis.setTimeout(
            () => reject(new Error("Capture target did not settle before its deadline")),
            remaining,
          );
        }),
      ]);
    } finally {
      globalThis.clearTimeout(timer);
    }
  };
  await bounded(scroll);
  let previous: State | undefined;
  for (let samples = 1; samples <= 20; samples++) {
    await bounded(settle);
    const state = await bounded(observe);
    requireCompleteCaptureTarget(state, target);
    if (previous && JSON.stringify(previous) === JSON.stringify(state))
      return { format_version: 1, label, target, samples, observation: state };
    previous = state;
  }
  throw new Error("Capture target geometry did not settle within 20 samples");
}

export function requireUnchangedCaptureTarget(
  before: CaptureTargetObservation,
  after: CaptureTargetObservation,
) {
  requireCompleteCaptureTarget(after, before.target);
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw new Error("Capture target changed during screenshot");
}

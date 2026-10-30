import { expect } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

function parityCaptureDirectory(testPath: string | undefined): string {
  const normalized = testPath?.replaceAll("\\", "/") ?? "";
  const desktopSource = normalized.lastIndexOf("/apps/desktop/src/");
  if (desktopSource < 0) throw new Error("Parity capture requires a Desktop source test path");
  return `${normalized.slice(0, desktopSource)}/outputs/ui-refinement/prototype-parity-states`;
}

/** Retain the current renderer fixture state without changing its controls or scroll. */
export async function captureParityState(name: string) {
  await globalThis.document.fonts.ready;
  await expect
    .poll(() => [...globalThis.document.images].every((image) => image.complete))
    .toBe(true);
  await expect
    .poll(() =>
      globalThis.document
        .getAnimations()
        .every((animation) =>
          animation.effect?.getComputedTiming().iterations === Infinity
            ? true
            : !animation.pending && ["finished", "idle"].includes(animation.playState),
        ),
    )
    .toBe(true);
  await new Promise<void>((resolve) =>
    globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(() => resolve())),
  );
  // Vitest resolves custom paths against the calling test, whose nesting varies.
  const directory = parityCaptureDirectory(expect.getState().testPath);
  const theme = globalThis.document.documentElement.dataset.theme ?? "default";
  const viewport = `${globalThis.innerWidth}x${globalThis.innerHeight}`;
  // The runner document may exceed its iframe. This transparent rectangle clips
  // to the actual viewport without altering the application layout or focus.
  const frame = globalThis.document.createElement("div");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;inset:0;pointer-events:none";
  globalThis.document.body.append(frame);
  try {
    await page.screenshot({
      path: `${directory}/${name}-${theme}-${viewport}.png`,
      element: frame,
    });
  } finally {
    frame.remove();
  }
}

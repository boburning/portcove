import { expect } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

function parityCaptureDirectory(testPath: string | undefined): string {
  const normalized = testPath?.replaceAll("\\", "/") ?? "";
  const desktopSource = normalized.lastIndexOf("/apps/desktop/src/");
  if (desktopSource < 0) throw new Error("Parity capture requires a Desktop source test path");
  return `${normalized.slice(0, desktopSource)}/outputs/ui-refinement/prototype-parity-states`;
}

/**
 * Wait until every image in the document has loaded or failed.
 *
 * The App shell serves its sidebar avatar as a 949 KB PNG from the test
 * server. On a loaded hosted runner that transfer can outlast the default
 * one-second poll. Each pass waits for the real load, error or abort event of
 * the images that are still incomplete, then rechecks, because a rerender can
 * add or replace images. The budget bounds this harness wait; it is not a product
 * deadline.
 */
export async function settleDocumentImages(timeout = 6_000) {
  const deadline = globalThis.performance.now() + timeout;
  for (;;) {
    const pending = [...globalThis.document.images].filter((image) => !image.complete);
    if (pending.length === 0) return;
    const remaining = deadline - globalThis.performance.now();
    if (remaining <= 0)
      throw new Error(
        `Images did not finish loading within ${timeout} ms: ${pending
          .map((image) => image.currentSrc || image.src)
          .join(", ")}`,
      );
    let expire!: ReturnType<typeof globalThis.setTimeout>;
    await Promise.race([
      Promise.all(
        pending.map(
          (image) =>
            new Promise<void>((resolve) => {
              for (const event of ["load", "error", "abort"])
                image.addEventListener(event, () => resolve(), { once: true });
            }),
        ),
      ),
      new Promise<void>((resolve) => {
        // Recheck periodically in case a source change replaces a request
        // without dispatching an event on the observed element.
        expire = globalThis.setTimeout(resolve, Math.min(remaining, 250));
      }),
    ]);
    globalThis.clearTimeout(expire);
  }
}

export async function captureViewportScreenshot(path: string) {
  // The runner document may exceed its iframe. This transparent rectangle clips
  // to the actual viewport without altering the application layout or focus.
  const frame = globalThis.document.createElement("div");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;inset:0;pointer-events:none";
  globalThis.document.body.append(frame);
  try {
    await page.screenshot({ path, element: frame });
  } finally {
    frame.remove();
  }
}

/** Retain the current renderer fixture state without changing its controls or scroll. */
export async function captureParityState(name: string) {
  await globalThis.document.fonts.ready;
  await settleDocumentImages();
  // A loaded hosted browser can schedule a finite transition after its first
  // frame. Keep waiting for the real settlement before taking the screenshot.
  await expect
    .poll(
      () =>
        globalThis.document
          .getAnimations()
          .every((animation) =>
            animation.effect?.getComputedTiming().iterations === Infinity
              ? true
              : !animation.pending && ["finished", "idle"].includes(animation.playState),
          ),
      { timeout: 6_000, message: "Wait for finite animations before capturing parity" },
    )
    .toBe(true);
  await new Promise<void>((resolve) =>
    globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(() => resolve())),
  );
  // Vitest resolves custom paths against the calling test, whose nesting varies.
  const directory = parityCaptureDirectory(expect.getState().testPath);
  const theme = globalThis.document.documentElement.dataset.theme ?? "default";
  const viewport = `${globalThis.innerWidth}x${globalThis.innerHeight}`;
  await captureViewportScreenshot(`${directory}/${name}-${theme}-${viewport}.png`);
}

import type { TestContext } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { observeVisibleTarget } from "../../scripts/browser-readiness.mts";
import { prepareCaptureTarget, requireUnchangedCaptureTarget } from "../../test/capture-target";

/** Thin browser adapter. Vitest retains metadata attachments for successful tests too. */
async function retainMetadata(context: Pick<TestContext, "annotate">, metadata: unknown) {
  const body = new TextEncoder().encode(`${JSON.stringify({ capture_target: metadata })}\n`);
  if (body.byteLength > 16 * 1024) throw new Error("Capture metadata exceeds16KiB");
  await context.annotate("Capture target geometry", "capture-target", {
    body,
    contentType: "application/json",
  });
}
export async function captureTargetScreenshot(
  element: Element,
  image: string,
  label: string,
  context: Pick<TestContext, "annotate">,
) {
  const previous = element.getAttribute("data-capture-target");
  const target = `[data-capture-target="${CSS.escape(label)}"]`;
  element.setAttribute("data-capture-target", label);
  try {
    const metadata = await prepareCaptureTarget({
      target,
      label,
      scroll: () =>
        element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }),
      observe: () => observeVisibleTarget(target, "visual"),
    });
    await page.screenshot({ element, path: image });
    requireUnchangedCaptureTarget(metadata.observation, observeVisibleTarget(target, "visual"));
    await retainMetadata(context, { ...metadata, image, outcome: "captured" });
    return metadata;
  } catch (error) {
    try {
      await retainMetadata(context, {
        label,
        target,
        image,
        outcome: "refused",
        observation: observeVisibleTarget(target, "visual"),
      });
    } catch {
      /* Preserve the original capture/retention failure. */
    }
    throw error;
  } finally {
    if (previous === null) element.removeAttribute("data-capture-target");
    else element.setAttribute("data-capture-target", previous);
  }
}

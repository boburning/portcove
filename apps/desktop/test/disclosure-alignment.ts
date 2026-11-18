import { expect } from "vite-plus/test";

/** Check the drawn marker against the first rendered text line, including RTL and wrapping. */
export function expectDisclosureAlignment(summary: Element) {
  if (summary.localName !== "summary") throw new Error("Expected a native disclosure summary");
  const view = summary.ownerDocument.defaultView;
  if (!view) throw new Error("Expected a disclosure in a mounted document");
  const text = summary.ownerDocument.createRange();
  text.selectNodeContents(summary);
  const firstLine = text.getClientRects()[0];
  if (!firstLine) throw new Error("Expected the disclosure's first text line");
  const style = view.getComputedStyle(summary);
  const marker = view.getComputedStyle(summary, "::before");
  const bounds = summary.getBoundingClientRect();
  const markerCenter = bounds.top + parseFloat(marker.top) + parseFloat(marker.height) / 2;
  expect(Math.abs(markerCenter - (firstLine.top + firstLine.height / 2))).toBeLessThanOrEqual(
    parseFloat(style.fontSize) / 4,
  );
  const markerInlineCenter =
    style.direction === "rtl"
      ? bounds.right - parseFloat(marker.right) - parseFloat(marker.width) / 2
      : bounds.left + parseFloat(marker.left) + parseFloat(marker.width) / 2;
  expect(markerInlineCenter).toBeGreaterThan(bounds.left);
  expect(markerInlineCenter).toBeLessThan(bounds.right);
  if (style.direction === "rtl") expect(markerInlineCenter).toBeGreaterThan(firstLine.right);
  else expect(markerInlineCenter).toBeLessThan(firstLine.left);
}

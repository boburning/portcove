// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationEvent } from "../types";
import { StatusLayer } from "./Chrome";

let container: HTMLDivElement, root: Root;
const event = (completed: number, total: number | null, phase = "download"): OperationEvent => ({
  schema_version: 2,
  operation_id: "owned-download",
  parent_operation_id: null,
  target: null,
  sequence: completed + 1,
  timestamp_ms: 1,
  operation: "install",
  type: "progress",
  phase,
  completed,
  total,
});
async function render(operation: OperationEvent) {
  await act(async () =>
    root.render(<StatusLayer clearError={() => {}} busy="install" operation={operation} />),
  );
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("accessible operation progress", () => {
  it("updates visible counts without mutating the phase live region", async () => {
    await render(event(0, 100));
    const status = container.querySelector('[role="status"]')!;
    const changes: MutationRecord[] = [];
    const observer = new MutationObserver((records) => changes.push(...records));
    observer.observe(status, {
      subtree: true,
      childList: true,
      characterData: true,
    });
    try {
      for (const completed of [1, 20, 99, 100]) await render(event(completed, 100));
      expect(changes).toHaveLength(0);
      expect(container.textContent).toContain("100 B of 100 B");
      expect(status.textContent).toBe("Downloading release");
      expect(container.querySelector('[role="progressbar"]')?.closest("[aria-live]")).toBeNull();
      await render(event(0, 10, "copy"));
      expect(container.querySelector('[role="status"]')).toBe(status);
      expect(status.textContent).toBe("Copying game files");
      expect(changes.length).toBeGreaterThan(0);
    } finally {
      observer.disconnect();
    }
  });

  it.each([
    { completed: 0, total: 0, now: null, text: "No bytes reported yet." },
    { completed: 0, total: 1, now: "0", text: "0 B of 1 B" },
    { completed: 1, total: 1, now: "1", text: "1 B of 1 B" },
    { completed: 99, total: 10, now: "10", text: "99 B of 10 B" },
    {
      completed: 1_000_000,
      total: 2_000_000,
      now: "1000000",
      text: "977 KiB of 1.9 MiB",
    },
    { completed: 3, total: null, now: null, text: "Total size not yet known" },
    { completed: -1, total: 10, now: null, text: "Total size not yet known" },
    {
      completed: Number.NaN,
      total: 10,
      now: null,
      text: "Total size not yet known",
    },
    {
      completed: 1,
      total: Number.POSITIVE_INFINITY,
      now: null,
      text: "Total size not yet known",
    },
    {
      completed: Number.MAX_SAFE_INTEGER + 1,
      total: 10,
      now: null,
      text: "Total size not yet known",
    },
  ])(
    "keeps accessible counts bounded for $completed of $total",
    async ({ completed, total, now, text }) => {
      await render(event(completed, total));
      const progress = container.querySelector('[role="progressbar"]')!;
      expect(progress.getAttribute("aria-valuenow")).toBe(now);
      expect(progress.getAttribute("aria-valuetext")).toContain(text);
      expect(progress.innerHTML).not.toMatch(/NaN|Infinity|width:-/);
      expect(progress.hasAttribute("aria-valuemax")).toBe(now !== null);
    },
  );

  it.each([
    {
      phase: "download",
      completed: 25 * 1024 * 1024,
      total: 80 * 1024 * 1024,
      label: "Downloading release",
      detail: "25.0 MiB of 80.0 MiB",
    },
    {
      phase: "psx-toolchain-download",
      completed: 1024,
      total: 2048,
      label: "Downloading preparation tools",
      detail: "1.0 KiB of 2.0 KiB",
    },
    {
      phase: "copy",
      completed: 1024,
      total: 2048,
      label: "Copying game files",
      detail: "1.0 KiB of 2.0 KiB",
    },
    {
      phase: "Checking installed ports",
      completed: 3,
      total: 12,
      label: "Checking installed ports",
      detail: "3 of 12 ports",
    },
    {
      phase: "Applying update policies",
      completed: 1,
      total: 1,
      label: "Applying update settings",
      detail: "1 of 1 port",
    },
  ])(
    "labels $phase progress with truthful units",
    async ({ phase, completed, total, label, detail }) => {
      await render(event(completed, total, phase));
      expect(container.querySelector('[role="status"]')?.textContent).toBe(label);
      expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuetext")).toBe(
        detail,
      );
      expect(container.textContent).toContain(detail);
    },
  );

  it.each([
    { phase: "download", detail: "Total size not yet known." },
    { phase: "Checking installed ports", detail: "Port total not yet known." },
  ])("uses a task-specific indeterminate detail for $phase", async ({ phase, detail }) => {
    await render(event(3, null, phase));
    expect(container.textContent).toContain(detail);
    expect(container.querySelector('[role="progressbar"]')?.hasAttribute("aria-valuenow")).toBe(
      false,
    );
  });

  it.each(["future_internal_operation_code", "constructor", "__proto__", "toString"])(
    "safely handles unknown phase %s",
    async (phase) => {
      await render(event(1, 2, phase));
      expect(container.querySelector('[role="status"]')?.textContent).toBe("Working");
      expect(container.textContent).not.toContain("future_internal");
      expect(container.textContent).not.toContain("complete");
    },
  );
});

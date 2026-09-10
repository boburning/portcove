// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import type { DoctorReport } from "../types";
import { portDefinition } from "../test-fixtures";
import { RecoveryReview } from "./RecoveryReview";

type Repair = DoctorReport["repair"];
const port = portDefinition();
const item = (): Repair["items"][number] => ({ kind: "partial_operation", operation_id: "owned-operation", port_id: port.id,
  path: "C:\\Owned library\\staging\\retained", message: "raw-machine-secret", proposed_action: "Review the retained work before another attempt." });
afterEach(() => { vi.unstubAllGlobals(); });

it("keeps unavailable information distinct from an empty recorded repair list", () => {
  const unavailable = renderToStaticMarkup(<RecoveryReview ports={[port]} />);
  const empty = renderToStaticMarkup(<RecoveryReview ports={[port]} repair={{ generated_at: 1, items: [] }} />);
  expect(unavailable).toContain("Recovery information is unavailable.");
  expect(unavailable).not.toContain("No recovery items");
  expect(empty).toContain("No recovery items were recorded in the last check.");
});

it("puts paths behind a collapsed review and omits raw errors and execution controls", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const repair = { generated_at: 1, items: [item()] }; const original = JSON.stringify(repair);
  const host = document.createElement("div"); const root = createRoot(host);
  try {
    await act(async () => root.render(<RecoveryReview repair={repair} ports={[port]} />));
    expect(host.textContent).toContain("1 recorded item needs review.");
    expect(host.querySelector("summary")?.textContent).toContain(port.name);
    const details = host.querySelector("details")!;
    expect(details.open).toBe(false);
    await act(async () => { details.open = true; details.dispatchEvent(new Event("toggle")); });
    expect(details.textContent).toContain(repair.items[0].path);
    expect(details.textContent).toContain(repair.items[0].proposed_action);
    expect(host.innerHTML).not.toContain("raw-machine-secret");
    expect(host.querySelectorAll("button,a")).toHaveLength(0);
    expect(JSON.stringify(repair)).toBe(original);
    await act(async () => root.render(<RecoveryReview repair={{ generated_at: 2, items: [] }} ports={[port]} />));
    expect(host.querySelector("details")).toBeNull();
    expect(host.textContent).not.toContain("owned-operation");
  } finally { await act(async () => root.unmount()); }
});

it.each(["future_kind", "constructor", "__proto__"])("uses a neutral label for %s", kind => {
  const entry = { ...item(), kind: kind as ReturnType<typeof item>["kind"], path: null, proposed_action: "", port_id: null, operation_id: null };
  const html = renderToStaticMarkup(<RecoveryReview repair={{ generated_at: 1, items: [entry] }} ports={[]} />);
  expect(html).toContain("Library · Recovery information needs review");
  expect(html).toContain("No location was recorded.");
  expect(html).toContain("No recovery guidance was recorded.");
  expect(html).not.toContain("raw-machine-secret");
});

it("retains every recorded item and full long names and paths", () => {
  const longPath = `C:\\${"owned-folder\\".repeat(40)}retained`;
  const items = Array.from({ length: 40 }, (_, index) => ({ ...item(), operation_id: `operation-${index}`, path: longPath }));
  const html = renderToStaticMarkup(<RecoveryReview repair={{ generated_at: 1, items }} ports={[{ ...port, name: "A long game name ".repeat(10) }]} />);
  expect(html).toContain("40 recorded items need review.");
  expect(html.match(/<details /g)).toHaveLength(40);
  expect(html).toContain(longPath);
  expect(html).toContain("operation-39");
  expect(html).not.toContain("raw-machine-secret");
});

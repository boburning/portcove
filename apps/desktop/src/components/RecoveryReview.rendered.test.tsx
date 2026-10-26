import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { RecoveryReview } from "./RecoveryReview";
import { port } from "./rendered-test-fixtures";
import { portDefinition } from "../test-fixtures";
import type { DoctorReport } from "../types";

describe("desktop components", () => {
  it("distinguishes never-loaded and stale recovery diagnostics from a healthy empty report", () => {
    const neverLoaded = renderToStaticMarkup(
      <RecoveryReview ports={[port]} refreshing={false} stale refresh={vi.fn()} />,
    );
    expect(neverLoaded).toContain('data-diagnostic-state="never-loaded"');
    expect(neverLoaded).toContain("has not been checked");
    expect(neverLoaded).toContain("Refresh recovery information");
    expect(neverLoaded).not.toContain("No recovery items were recorded");

    const stale = renderToStaticMarkup(
      <RecoveryReview
        ports={[port]}
        repair={{ generated_at: 1, items: [] }}
        refreshing
        stale
        refresh={vi.fn()}
      />,
    );
    expect(stale).toContain("last completed check remains visible");
    expect(stale).toContain("No recovery items were recorded");
  });
});

type Repair = DoctorReport["repair"];
const recoveryPort = portDefinition();
const item = (): Repair["items"][number] => ({
  kind: "partial_operation",
  operation_id: "owned-operation",
  port_id: recoveryPort.id,
  path: "C:\\Owned library\\staging\\retained",
  message: "raw-machine-secret",
  proposed_action: "Review the retained work before another attempt.",
});
const freshDiagnostics = {
  refreshing: false,
  stale: false,
  refresh: vi.fn().mockResolvedValue("completed"),
};

it("keeps unavailable information distinct from an empty recorded repair list", () => {
  const unavailable = renderToStaticMarkup(
    <RecoveryReview {...freshDiagnostics} ports={[recoveryPort]} stale />,
  );
  const empty = renderToStaticMarkup(
    <RecoveryReview
      {...freshDiagnostics}
      ports={[recoveryPort]}
      repair={{ generated_at: 1, items: [] }}
    />,
  );
  expect(unavailable).toContain("has not been checked for the current library state");
  expect(unavailable).not.toContain("No recovery items");
  expect(empty).toContain("No recovery items were recorded in the last check.");
  expect(unavailable).toContain("rounded-pc-lg border border-pc-border");
  expect(empty).toContain("py-2");
  expect(empty).not.toContain("rounded-pc-lg border");
});

it.each(["future_kind", "constructor", "__proto__"])("uses a neutral label for %s", (kind) => {
  const entry = {
    ...item(),
    kind: kind as ReturnType<typeof item>["kind"],
    path: null,
    proposed_action: "",
    port_id: null,
    operation_id: null,
  };
  const html = renderToStaticMarkup(
    <RecoveryReview
      {...freshDiagnostics}
      repair={{ generated_at: 1, items: [entry] }}
      ports={[]}
    />,
  );
  expect(html).toContain("Library · Recovery information needs review");
  expect(html).toContain("No location was recorded.");
  expect(html).toContain("No recovery guidance was recorded.");
  expect(html).not.toContain("raw-machine-secret");
});

it("retains every recorded item and full long names and paths", () => {
  const longPath = `C:\\${"owned-folder\\".repeat(40)}retained`;
  const items = Array.from({ length: 40 }, (_, index) => ({
    ...item(),
    operation_id: `operation-${index}`,
    path: longPath,
  }));
  const html = renderToStaticMarkup(
    <RecoveryReview
      {...freshDiagnostics}
      repair={{ generated_at: 1, items }}
      ports={[{ ...recoveryPort, name: "A long game name ".repeat(10) }]}
    />,
  );
  expect(html).toContain("40 recorded items need review.");
  expect(html.match(/<details(?:\s|>)/g)).toHaveLength(40);
  expect(html).toContain(longPath);
  expect(html).toContain("operation-39");
  expect(html).not.toContain("raw-machine-secret");
});

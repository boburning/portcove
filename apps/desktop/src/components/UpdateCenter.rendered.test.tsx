import { portStatus, sourceProfile } from "../test-fixtures";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import type { ActivityRecord, PortStatus } from "../types";
import { UpdateCenter } from "./UpdateCenter";
import { port, installRecord } from "./rendered-test-fixtures";

describe("desktop components", () => {
  it.each(["future_state", "constructor", "__proto__"])(
    "keeps unknown activity and policy labels neutral for %s",
    (value) => {
      const status = {
        ...portStatus(),
        active: installRecord(),
        channel: value as PortStatus["channel"],
        update_policy: value as PortStatus["update_policy"],
      };
      const html = renderToStaticMarkup(
        <UpdateCenter
          generation={1}
          ports={[port]}
          statuses={new Map([[port.id, status]])}
          activities={[
            {
              id: "unknown",
              operation: value as import("../types").ActivityOperation,
              target_kind: "port",
              target_id: port.id,
              status: "succeeded",
              started_at: 1,
              finished_at: 2,
              failure: null,
              cancellation: null,
              message: null,
            },
          ]}
          outcomes={[]}
          diagnosticsRefreshing={false}
          diagnosticsStale={false}
          refreshDiagnostics={vi.fn()}
          checkAll={vi.fn()}
          onSelect={vi.fn()}
          onOpenSettings={vi.fn()}
        />,
      );
      expect(html).toMatch(/<span[^>]*>Activity<\/span>/u);
      expect(html).toContain("Unknown channel");
      expect(html).toContain("Update policy unavailable");
      expect(html).not.toContain("· Notify");
    },
  );

  it("summarizes update checks and exposes policy reconciliation", () => {
    const install = installRecord();
    const status: PortStatus = {
      ...portStatus(),
      port_id: port.id,
      channel: "stable",
      update_policy: "notify",
      active: install,
    };
    const html = renderToStaticMarkup(
      <UpdateCenter
        generation={1}
        ports={[port]}
        sourceProfiles={[{ ...sourceProfile(), id: "sample-rom", label: "Sample cartridge" }]}
        statuses={new Map([[port.id, status]])}
        activities={[
          {
            id: "activity-1",
            failure: null,
            cancellation: null,
            message: null,
            operation: "update",
            target_kind: "port",
            target_id: port.id,
            status: "succeeded",
            started_at: 1,
            finished_at: 2,
          },
          {
            id: "activity-copy",
            failure: null,
            cancellation: null,
            message: null,
            operation: "adopt",
            target_kind: "port",
            target_id: port.id,
            status: "succeeded",
            started_at: 2,
            finished_at: 3,
          },
          {
            id: "activity-policy",
            failure: null,
            cancellation: null,
            message: null,
            operation: "reconcile",
            target_kind: "port",
            target_id: port.id,
            status: "running",
            started_at: Math.floor(Date.now() / 1000),
            finished_at: null,
          },
          {
            id: "activity-2",
            failure: null,
            cancellation: null,
            operation: "verify_source",
            target_kind: "source",
            target_id: "sample-rom",
            status: "failed",
            message: "source changed",
            started_at: 3,
            finished_at: 4,
          },
          {
            id: "activity-3",
            failure: null,
            cancellation: null,
            message: null,
            finished_at: null,
            operation: "install",
            target_kind: "port",
            target_id: port.id,
            status: "running",
            started_at: 1,
          },
          {
            id: "activity-missing-source",
            failure: null,
            cancellation: null,
            message: null,
            operation: "verify_source",
            target_kind: "source",
            target_id: "removed-profile",
            status: "succeeded",
            started_at: 4,
            finished_at: 5,
          },
          {
            id: "activity-4",
            failure: null,
            cancellation: null,
            message: null,
            operation: "install",
            target_kind: "port",
            target_id: port.id,
            status: "cancelled",
            started_at: 5,
            finished_at: 6,
          },
          {
            id: "activity-5",
            failure: null,
            cancellation: null,
            message: null,
            operation: "install",
            target_kind: "port",
            target_id: port.id,
            status: "future-status" as ActivityRecord["status"],
            started_at: 7,
            finished_at: 8,
          },
          {
            id: "activity-6",
            failure: null,
            cancellation: null,
            message: null,
            operation: "install",
            target_kind: "port",
            target_id: port.id,
            status: "running",
            started_at: Math.floor(Date.now() / 1000),
            finished_at: null,
          },
        ]}
        busy={undefined}
        diagnosticsRefreshing={false}
        diagnosticsStale={false}
        refreshDiagnostics={vi.fn()}
        checkAll={vi.fn()}
        onSelect={vi.fn()}
        onOpenSettings={vi.fn()}
        outcomes={[
          {
            port_id: port.id,
            ok: true,
            error: null,
            result: {
              port_id: port.id,
              channel: "stable",
              installed_version: "1.0",
              installed_runtime: null,
              required_runtime: null,
              installed_artifact: null,
              update_available: true,
              release: {
                published_at: null,
                version: "2.0",
                channel: "stable",
                asset: {
                  name: "sample.zip",
                  url: "https://example.com/sample.zip",
                  size: 1,
                  sha256: "a".repeat(64),
                },
              },
            },
          },
        ]}
      />,
    );
    expect(html).toContain("2.0");
    expect(html).toContain("Latest eligible");
    expect(html).toContain("Checking only looks for updates");
    expect(html).toContain("Update available");
    expect(html).toContain("Stable · Notify me");
    expect(html).toContain("Check installed ports for updates");
    expect(html).toContain("Task records");
    expect(html).toContain(`data-detail-origin="updates:installed:${port.id}"`);
    expect(html).toContain(`data-detail-origin="updates:activity:activity-1:target"`);
    expect(html).toContain("Game update");
    expect(html).toContain("Game-file check");
    expect(html).toContain("Existing-installation copy");
    expect(html).toContain("Update policy run");
    expect(html).not.toContain("Update settings run");
    expect(html).not.toContain("Adopted installation");
    expect(html).toContain("More details may be available in a support bundle.");
    expect(html).not.toContain("source changed");
    for (const label of [
      "Completed",
      "Failed",
      "Cancelled",
      "Status unavailable",
      "May have been interrupted",
      "In progress",
    ])
      expect(html).toMatch(new RegExp(`<span class="activity-status [^"]*">${label}</span>`));
    expect(html).not.toMatch(
      /activity-status [^"]*">(?:succeeded|failed|cancelled|unfinished|running)</,
    );
    expect(html).toContain("No completion reported");
    expect(html).toMatch(
      /<p class="activity-details [^"]*">This task has not reported completion\. Review its details before retrying\.<\/p>/u,
    );
    expect(html).not.toContain('title="This task has not reported completion');
    expect(html).not.toContain("Needs review");
    expect(html).toMatch(
      /<button[^>]*data-variant="link"[^>]*data-focusable="true"[^>]*>Sample cartridge<\/button>/u,
    );
    expect(html).toContain('aria-label="Open Game files settings for Sample cartridge"');
    expect(html).not.toMatch(/>sample-rom<\/button>/u);
    expect(html).toMatch(
      /<button[^>]*data-variant="link"[^>]*data-focusable="true"[^>]*>removed-profile<\/button>/u,
    );
    expect(html).toContain("Activity from the CLI and desktop appears here.");
  });
});

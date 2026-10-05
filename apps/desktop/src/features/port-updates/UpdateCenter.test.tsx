// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as clipboard from "../../clipboard";
import type { UpdateBatchRead } from "./use-update-center";
import { UpdateCenter } from "../../components/UpdateCenter";
import { failureReport, portDefinition, portStatus } from "../../test-fixtures";
import type {
  ActivityFeed,
  ActivityRecord,
  InstallRecord,
  PortStatus,
  UpdateCheckOutcome,
} from "../../types";

const port = { ...portDefinition(), name: "Sample Port" };

const installRecord = (overrides: Partial<InstallRecord> = {}): InstallRecord => ({
  id: "1",
  port_id: port.id,
  version: "1.0",
  path: "sample/1.0",
  channel: "stable",
  installed_at: 1,
  verified: true,
  staged: false,
  artifact: { asset_name: "sample.zip", sha256: "b".repeat(64), size: 1 },
  manifest_sha256: "c".repeat(64),
  selected_executable: "sample.exe",
  runtime: null,
  ...overrides,
});

describe("update center presentation", () => {
  it("counts displayed finished activity separately from loaded history and protected rows", () => {
    const finished: ActivityRecord[] = Array.from({ length: 10 }, (_, index) => ({
      id: `finished-${index}`,
      operation: "backup",
      target_kind: "port",
      target_id: port.id,
      status: "succeeded",
      started_at: 100 - index,
      finished_at: 101 - index,
      message: null,
      failure: null,
      cancellation: null,
    }));
    const records: ActivityRecord[] = [
      ...finished,
      { ...finished[0], id: "attention", status: "failed" },
      { ...finished[0], id: "current", operation: "install", status: "running", finished_at: null },
    ];
    const feed: ActivityFeed = {
      records,
      current_activity_ids: ["current"],
      attention_required_activity_ids: ["attention"],
      recovery_required_activity_ids: [],
      active_and_actionable_complete: true,
      terminal_history_limit: 11,
      terminal_history_count: 11,
      terminal_history_complete: true,
    };
    const renderHistory = (activityFeed: ActivityFeed, displayRecords = records) =>
      renderToStaticMarkup(
        <UpdateCenter
          generation={1}
          ports={[port]}
          statuses={new Map()}
          activities={displayRecords}
          activityFeed={activityFeed}
          outcomes={[]}
          diagnosticsRefreshing={false}
          diagnosticsStale={false}
          refreshDiagnostics={vi.fn()}
          checkAll={vi.fn()}
          onSelect={vi.fn()}
          onOpenSettings={vi.fn()}
        />,
      );
    const complete = renderHistory(feed);
    expect(complete).toContain("Showing 8 recent finished tasks");
    expect(complete.match(/class="activity-row /gu)).toHaveLength(10);
    expect(complete).not.toContain("Earlier finished tasks exist");
    expect(renderHistory({ ...feed, terminal_history_complete: false })).toContain(
      "Earlier finished tasks exist beyond the records loaded here.",
    );
    expect(renderHistory({ ...feed, active_and_actionable_complete: false })).toContain(
      "Current work and attention coverage is incomplete.",
    );
    const withUnknownStatus = [...records];
    withUnknownStatus[2] = {
      ...withUnknownStatus[2],
      status: "future-status" as ActivityRecord["status"],
    };
    expect(renderHistory({ ...feed, records: withUnknownStatus }, withUnknownStatus)).toContain(
      "Showing 7 recent finished tasks",
    );
  });

  it("keeps update policy and last-check states distinct in the installed list", () => {
    const status: PortStatus = { ...portStatus(), active: installRecord() };
    const result: NonNullable<UpdateCheckOutcome["result"]> = {
      port_id: port.id,
      channel: "stable",
      installed_version: "1.0",
      installed_runtime: null,
      required_runtime: null,
      installed_artifact: null,
      update_available: false,
      release: {
        published_at: null,
        version: "1.0",
        channel: "stable",
        asset: {
          name: "sample.zip",
          url: "https://example.com/sample.zip",
          size: 1,
          sha256: "a".repeat(64),
        },
      },
    };
    const render = (current: PortStatus, outcomes: UpdateCheckOutcome[] = []) =>
      renderToStaticMarkup(
        <UpdateCenter
          generation={1}
          ports={[port]}
          statuses={new Map([[port.id, current]])}
          activities={[]}
          outcomes={outcomes}
          diagnosticsRefreshing={false}
          diagnosticsStale={false}
          refreshDiagnostics={vi.fn()}
          checkAll={vi.fn()}
          onSelect={vi.fn()}
          onOpenSettings={vi.fn()}
        />,
      );
    for (const [policy, label] of [
      ["notify", "Notify me"],
      ["stage", "Download for later"],
      ["automatic", "Install when I run updates"],
    ] as const) {
      expect(render({ ...status, update_policy: policy })).toContain(`Stable · ${label}`);
    }
    const states: Array<[string, PortStatus, UpdateCheckOutcome[]]> = [
      ["Not checked", status, []],
      ["Update saved for later", { ...status, staged: installRecord({ version: "2.0" }) }, []],
      [
        "No update found at last check",
        status,
        [{ port_id: port.id, ok: true, error: null, result }],
      ],
      [
        "Update available",
        status,
        [
          {
            port_id: port.id,
            ok: true,
            error: null,
            result: { ...result, update_available: true },
          },
        ],
      ],
      [
        "Check result unavailable",
        status,
        [{ port_id: port.id, ok: true, error: null, result: null }],
      ],
      [
        "Check failed",
        status,
        [{ port_id: port.id, ok: false, error: failureReport(), result: null }],
      ],
      [
        "Check failed",
        { ...status, staged: installRecord({ version: "2.0" }) },
        [{ port_id: port.id, ok: false, error: failureReport(), result: null }],
      ],
    ];
    for (const [label, current, outcomes] of states)
      expect(render(current, outcomes)).toContain(`>${label}</span>`);

    expect(render(status)).toMatch(
      /<small[^>]*>Latest eligible<\/small><span[^>]*>Not checked<\/span>/u,
    );
    expect(
      render(status, [{ port_id: port.id, ok: false, error: failureReport(), result: null }]),
    ).toMatch(/<small[^>]*>Latest eligible<\/small><span[^>]*>Check failed<\/span>/u);
    expect(render(status, [{ port_id: port.id, ok: true, error: null, result: null }])).toMatch(
      /<small[^>]*>Latest eligible<\/small><span[^>]*>Unavailable<\/span>/u,
    );
    expect(render(status)).toMatch(
      /<strong[^>]*>Unknown<\/strong><span[^>]*>Updates available<\/span>/u,
    );
    expect(render(status, [{ port_id: port.id, ok: true, error: null, result }])).toMatch(
      /<strong[^>]*>0<\/strong><span[^>]*>Updates available<\/span>/u,
    );
    expect(
      render(status, [{ port_id: port.id, ok: false, error: failureReport(), result: null }]),
    ).toContain("Update results cover 0 of 1 installed games.");

    const savedCheck = {
      ...result,
      installed_artifact: status.active!.artifact,
      installed_runtime: status.active!.runtime ?? null,
    };
    const saved = render(
      { ...status, last_update_check: { checked_at: 1_700_000_000, check: savedCheck } },
      [{ port_id: port.id, ok: true, error: null, result: savedCheck }],
    );
    expect(saved).toContain("Update results cover 1 of 1 installed games.");
    expect(saved).toContain("Latest saved check:");
    const savedStatus = {
      ...status,
      last_update_check: { checked_at: 1_700_000_000, check: savedCheck },
    };
    const restored = render(savedStatus);
    expect(restored).toContain("Update results cover 1 of 1 installed games.");
    expect(restored).toContain(">No update found at last check</span>");
    expect(restored).toMatch(/<strong[^>]*>0<\/strong><span[^>]*>Updates available<\/span>/u);
    expect(restored).toContain("Latest saved check:");
    const savedAvailable = render({
      ...savedStatus,
      last_update_check: {
        checked_at: 1_700_000_000,
        check: {
          ...savedCheck,
          update_available: true,
          release: { ...result.release, version: "2.0" },
        },
      },
    });
    expect(savedAvailable).toContain(">Update available at last check</span>");
    expect(savedAvailable).toMatch(/<strong[^>]*>1<\/strong><span[^>]*>Updates available<\/span>/u);
    expect(savedAvailable).toContain(">2.0</span>");
    const changedInstall = render({ ...savedStatus, active: installRecord({ version: "2.0" }) });
    expect(changedInstall).toContain("Update results cover 0 of 1 installed games.");
    expect(changedInstall).toContain(">Not checked</span>");
    expect(changedInstall).not.toContain("Latest saved check:");
    const wrongPortCheck = render({
      ...savedStatus,
      last_update_check: {
        checked_at: 1_700_000_000,
        check: { ...savedCheck, port_id: "other-game" },
      },
    });
    expect(wrongPortCheck).toContain("Update results cover 0 of 1 installed games.");
    for (const attempted of [
      { port_id: port.id, ok: false, error: failureReport(), result: null },
      { port_id: port.id, ok: true, error: null, result: null },
    ]) {
      const incomplete = render(savedStatus, [attempted]);
      expect(incomplete).toContain("Update results cover 0 of 1 installed games.");
      expect(incomplete).toContain("Latest saved check:");
      expect(incomplete).toMatch(
        /<strong[^>]*>Unknown<\/strong><span[^>]*>Updates available<\/span>/u,
      );
      expect(incomplete).not.toContain(">No update found at last check</span>");
    }

    const second = { ...port, id: "second-game", name: "Second game" };
    const partial = renderToStaticMarkup(
      <UpdateCenter
        generation={1}
        ports={[port, second]}
        statuses={
          new Map([
            [port.id, status],
            [second.id, { ...status, port_id: second.id }],
          ])
        }
        activities={[]}
        outcomes={[
          {
            port_id: port.id,
            ok: true,
            error: null,
            result: { ...result, update_available: true },
          },
        ]}
        diagnosticsRefreshing={false}
        diagnosticsStale={false}
        refreshDiagnostics={vi.fn()}
        checkAll={vi.fn()}
        onSelect={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );
    expect(partial).toMatch(/<strong[^>]*>1\+<\/strong><span[^>]*>Updates available<\/span>/u);
    expect(partial).toContain("Update results cover 1 of 2 installed games.");
  });

  it("describes activity mutations with outcomes shared producers can support", () => {
    const activities: ActivityRecord[] = [
      {
        id: "activity-backup",
        failure: null,
        cancellation: null,
        message: null,
        operation: "backup",
        target_kind: "port",
        target_id: port.id,
        status: "succeeded",
        started_at: 10,
        finished_at: 11,
      },
      {
        id: "activity-remove",
        failure: null,
        cancellation: null,
        message: null,
        operation: "remove",
        target_kind: "port",
        target_id: port.id,
        status: "succeeded",
        started_at: 11,
        finished_at: 12,
      },
      {
        id: "activity-remove-source",
        failure: null,
        cancellation: null,
        message: null,
        operation: "remove_source",
        target_kind: "source",
        target_id: "sample-rom",
        status: "succeeded",
        started_at: 12,
        finished_at: 13,
      },
      {
        id: "activity-register-source",
        failure: null,
        cancellation: null,
        message: null,
        operation: "register_source",
        target_kind: "source",
        target_id: "sample-rom",
        status: "succeeded",
        started_at: 13,
        finished_at: 14,
      },
      {
        id: "activity-discover-sources",
        failure: null,
        cancellation: null,
        message: null,
        operation: "discover_sources",
        target_kind: "library",
        target_id: null,
        status: "succeeded",
        started_at: 14,
        finished_at: 15,
      },
    ];
    const html = renderToStaticMarkup(
      <UpdateCenter
        generation={1}
        ports={[port]}
        statuses={new Map()}
        activities={activities}
        outcomes={[]}
        diagnosticsRefreshing={false}
        diagnosticsStale={false}
        refreshDiagnostics={vi.fn()}
        checkAll={vi.fn()}
        onSelect={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    for (const label of [
      "Backup",
      "Uninstall",
      "Game-file location removal",
      "Game-file location update",
      "Game-file search",
    ])
      expect(html).toContain(label);
    for (const internalLabel of [
      "Backed up data",
      "Removed managed files",
      "Removed source reference",
      "Registered source",
      "Added game file",
      "Searched for sources",
    ])
      expect(html).not.toContain(internalLabel);
  });

  it("explains empty update and activity states without internal lifecycle jargon", () => {
    const html = renderToStaticMarkup(
      <UpdateCenter
        generation={1}
        ports={[]}
        statuses={new Map()}
        activities={[]}
        outcomes={[]}
        diagnosticsRefreshing={false}
        diagnosticsStale={false}
        refreshDiagnostics={vi.fn()}
        checkAll={vi.fn()}
        onSelect={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );
    expect(html).toContain(
      "Install a port or copy in an existing installation first. Portcove will then show its update channel, update setting, latest available release, and previous installed version here.",
    );
    expect(html).toContain("Activity from the CLI and desktop appears here.");
    expect(html).toContain("No activity yet");
    expect(html).toContain(
      "Installs, updates, verification, restored versions, copied installations, and failures will appear here.",
    );
    expect(html.toLowerCase()).not.toContain("adopt");
    expect(html).not.toContain("No operations recorded yet");
  });
});

const priorResult: NonNullable<UpdateCheckOutcome["result"]> = {
  port_id: port.id,
  channel: "stable",
  installed_version: "1.0",
  installed_artifact: installRecord().artifact,
  installed_runtime: null,
  required_runtime: null,
  update_available: true,
  release: {
    published_at: null,
    version: "2.0",
    channel: "stable",
    asset: {
      name: "sample-2.zip",
      url: "https://example.com/sample-2.zip",
      size: 2,
      sha256: "a".repeat(64),
    },
  },
};
function batchHtml(batchRead: UpdateBatchRead, outcomes: UpdateCheckOutcome[] = []) {
  return renderToStaticMarkup(
    <UpdateCenter
      generation={1}
      ports={[port]}
      statuses={new Map([[port.id, { ...portStatus(), active: installRecord() }]])}
      activities={[]}
      outcomes={outcomes}
      batchRead={batchRead}
      diagnosticsRefreshing={false}
      diagnosticsStale={false}
      refreshDiagnostics={vi.fn()}
      checkAll={vi.fn()}
      onSelect={vi.fn()}
      onOpenSettings={vi.fn()}
    />,
  );
}

it.each(["pending", "failed", "cancelled"] as const)(
  "marks retained results as prior-check facts when the batch is %s",
  (status) => {
    const html = batchHtml({ status, hasResults: true }, [
      { port_id: port.id, ok: true, error: null, result: priorResult },
    ]);
    expect(html).toContain(">Update available at last check</span>");
    expect(html).toContain("Earlier update results cover 1 of 1 installed games");
    expect(html).toContain("Updates at last check");
    expect(html).toContain("Failed at last check");
    expect(html).toContain("Latest eligible at last check");
    expect(html).toContain(">2.0</span>");
    expect(html).not.toContain(">Update available</span>");
  },
);

it("keeps individual failed and unavailable results visible without replacing them with saved success", () => {
  const failed = batchHtml({ status: "failed", hasResults: true }, [
    { port_id: port.id, ok: false, result: null, error: failureReport() },
  ]);
  expect(failed).toContain(">Earlier check failed</span>");
  expect(failed).toMatch(/<strong[^>]*>1<\/strong><span[^>]*>Failed at last check<\/span>/u);
  expect(failed).toContain("Earlier update results cover 0 of 1 installed games");
  const unavailable = batchHtml({ status: "pending", hasResults: true }, [
    { port_id: port.id, ok: true, result: null, error: null },
  ]);
  expect(unavailable).toContain(">Earlier check result unavailable</span>");
  expect(unavailable).toContain("Unavailable");
  expect(unavailable).not.toContain(">Update available at last check</span>");
});

it("keeps batch failure count unknown when no individual results are available", () => {
  const html = batchHtml({ status: "failed", hasResults: false });
  expect(html).toMatch(/<strong[^>]*>Unknown<\/strong><span[^>]*>Failed at last check<\/span>/u);
  expect(html).toContain(">Not checked</span>");
  expect(html).not.toContain(">Check failed</span>");
  expect(html).toContain("Current update results are unavailable");
  expect(html).toContain("Retry only checks for updates");
  expect(html).toContain("Retry update check");
});

it("keeps batch technical diagnostics private and does not infer a mutation result", () => {
  const failure = failureReport().presentation;
  failure.technical_message = "private/batch/read/path";
  failure.technical_context = { path: "private/batch/read/path" };
  const html = batchHtml({ status: "failed", hasResults: false, failure });
  const primary = html.slice(0, html.indexOf("<details"));
  expect(primary).not.toContain("private/batch/read/path");
  expect(primary).not.toContain("whether anything changed");
  expect(primary).not.toContain("No files were changed");
  expect(primary).not.toContain("The change was saved");
  expect(html).toContain("View technical details");
  expect(html).toContain("private/batch/read/path");
});

it("exposes a complete per-game failure separately from navigation and keeps raw fields private", () => {
  const error = failureReport();
  error.message = "raw-provider-secret";
  error.details = { token: "raw-field-secret" };
  error.presentation.summary = "The release check failed. " + "Review the connection. ".repeat(8);
  error.presentation.phase = "release.check";
  error.presentation.technical_message = "The owned endpoint was unavailable.";
  error.presentation.technical_context = { endpoint: "[REDACTED]" };
  const original = JSON.stringify(error);
  const html = batchHtml({ status: "current", hasResults: true }, [
    { port_id: port.id, ok: false, result: null, error },
  ]);
  expect(html).toContain('aria-label="Update check failure for Sample Port"');
  expect(html).toContain(error.presentation.summary);
  expect(html).toContain("View technical details");
  expect(html).toContain("release.check");
  expect(html).not.toContain("raw-provider-secret");
  expect(html).not.toContain("raw-field-secret");
  expect(html).not.toContain("No files were changed");
  expect(html).not.toContain("whether anything changed");
  expect(JSON.stringify(error)).toBe(original);
});

describe("individual update failure interaction", () => {
  let root: Root;
  let container: HTMLDivElement;
  let onSelect: ReturnType<typeof vi.fn>;
  let checkAll: ReturnType<typeof vi.fn>;

  function view(error = failureReport()) {
    const healthy = { ...port, id: "healthy", name: "Healthy Port" };
    return (
      <UpdateCenter
        generation={1}
        ports={[port, healthy]}
        statuses={
          new Map([
            [port.id, { ...portStatus(), active: installRecord() }],
            [
              healthy.id,
              {
                ...portStatus(),
                port_id: healthy.id,
                active: installRecord({ port_id: healthy.id }),
              },
            ],
          ])
        }
        activities={[]}
        outcomes={[
          { port_id: port.id, ok: false, result: null, error },
          {
            port_id: healthy.id,
            ok: true,
            error: null,
            result: { ...priorResult, port_id: healthy.id, update_available: false },
          },
        ]}
        batchRead={{ status: "current", hasResults: true }}
        diagnosticsRefreshing={false}
        diagnosticsStale={false}
        refreshDiagnostics={vi.fn()}
        checkAll={checkAll}
        onSelect={onSelect}
        onOpenSettings={vi.fn()}
      />
    );
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    onSelect = vi.fn();
    checkAll = vi.fn();
    vi.spyOn(clipboard, "copyText").mockResolvedValue();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("opens and copies only the failed game's supplied diagnostics without navigating or running a check", async () => {
    const error = failureReport();
    error.message = "raw-secret";
    error.details = { token: "raw-secret" };
    await act(async () => root.render(view(error)));
    const region = container.querySelector<HTMLElement>(
      '[aria-label="Update check failure for Sample Port"]',
    );
    expect(region).not.toBeNull();
    expect(
      container.querySelector('[aria-label="Update check failure for Healthy Port"]'),
    ).toBeNull();
    expect(region!.closest("button")).toBeNull();
    const details = region!.querySelector("details")!;
    expect(details.open).toBe(false);
    await act(async () => details.querySelector("summary")!.click());
    expect(details.open).toBe(true);
    await act(async () => region!.querySelector<HTMLButtonElement>("button")!.click());
    expect(JSON.parse(vi.mocked(clipboard.copyText).mock.calls[0][0])).toEqual({
      code: error.code,
      mutation_state: error.presentation.mutation_state,
      phase: error.presentation.phase,
      message: error.presentation.technical_message,
      context: error.presentation.technical_context,
    });
    expect(vi.mocked(clipboard.copyText).mock.calls[0][0]).not.toContain("raw-secret");
    expect(onSelect).not.toHaveBeenCalled();
    expect(checkAll).not.toHaveBeenCalled();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(`[data-detail-origin="updates:installed:${port.id}"]`)!
        .click(),
    );
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(port.id, `updates:installed:${port.id}`);
  });

  it("does not attach an old copy acknowledgement to a replacement failure report", async () => {
    let finish!: () => void;
    vi.mocked(clipboard.copyText).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    await act(async () => root.render(view()));
    const selector = '[aria-label="Update check failure for Sample Port"] button';
    const old = container.querySelector<HTMLButtonElement>(selector);
    expect(old).not.toBeNull();
    await act(async () => old!.click());
    const replacement = failureReport();
    replacement.presentation.summary = "A different check failed.";
    replacement.presentation.technical_context = { request: "replacement" };
    await act(async () => root.render(view(replacement)));
    await act(async () => finish());
    expect(container.querySelector(selector)?.textContent).toBe("Copy technical details");
    expect(onSelect).not.toHaveBeenCalled();
    expect(checkAll).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { DetailPanel, type DetailActions } from "./components/DetailPanel";
import { PortBrowser } from "./components/PortBrowser";
import { desktopApi } from "./api";
import { portDefinition, portStatus } from "./test-fixtures";
import type { ActivityRecord, InstallPlan, PortStatus, ReadinessBlocker } from "./types";
import { filterPorts, portReadiness, summarizeLibrary } from "./view-model";

const port = { ...portDefinition(), source_profile: "owned-source" };
const installed = (readiness?: PortStatus["readiness"]): PortStatus => ({
  ...portStatus(),
  active: {
    id: "owned-install",
    port_id: port.id,
    version: "1.0",
    path: "D:/Library/versions/owned",
    channel: "stable",
    installed_at: 1,
    verified: true,
    staged: false,
    artifact: { asset_name: "owned.zip", sha256: "a".repeat(64), size: 1 },
    manifest_sha256: "b".repeat(64),
    selected_executable: "game.exe",
    runtime: null,
  },
  readiness,
  last_launched_at: 1,
  successful_launches: 1,
});
const actions: DetailActions = {
  activate: vi.fn(),
  backup: vi.fn(),
  check: vi.fn(),
  close: vi.fn(),
  deleteBackup: vi.fn(),
  dismissInstallReview: vi.fn(),
  install: vi.fn(),
  launch: vi.fn(),
  openUserData: vi.fn(),
  reviewInstall: vi.fn(),
  remove: vi.fn(),
  restoreBackup: vi.fn(),
  rollback: vi.fn(),
  setChannel: vi.fn(),
  setPolicy: vi.fn(),
  verify: vi.fn(),
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("shows a core-held managed setup reason before installation review", () => {
  const status: PortStatus = {
    ...portStatus(),
    port_actions: [
      {
        action: "install",
        availability: "held",
        reason: "definition_ineligible",
        definition: { outcome: "hold", reason: "publisher_revoked" },
      },
    ],
  };
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(
    <DetailPanel
      port={portDefinition()}
      status={status}
      sourcePath=""
      setSourcePath={vi.fn()}
      actions={actions}
    />,
  );
  expect(host.textContent).toContain("Setup is on hold. The catalog publisher was revoked.");
  expect(
    [...host.querySelectorAll("button")].some(
      (button) => !button.disabled && button.textContent?.includes("Review installation"),
    ),
  ).toBe(false);
});

it("explains a retained launch hold without presenting it as missing game files", () => {
  const status: PortStatus = {
    ...installed({ launchable: false, pending_setup: false, blockers: [], source: "current" }),
    port_actions: [
      {
        action: "launch",
        availability: "held",
        reason: "definition_ineligible",
        definition: { outcome: "hold", reason: "publisher_revoked" },
      },
    ],
  };
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(
    <DetailPanel
      port={port}
      status={status}
      sourcePath=""
      setSourcePath={vi.fn()}
      actions={actions}
    />,
  );
  expect(host.textContent).toContain("Launch is on hold. The catalog publisher was revoked.");
  expect(host.querySelector<HTMLButtonElement>(".primary-actions button")!.disabled).toBe(true);
  expect(host.textContent).not.toContain("Choose required game files");
});

it.each([undefined, null])(
  "keeps an installed game out of Ready when the core assessment is %s",
  (readiness) => {
    const status = installed(readiness);
    const statuses = new Map([[port.id, status]]);
    expect(portReadiness(status)).toBe("unknown");
    expect(filterPorts([port], statuses, "library", "ready", "")).toEqual([]);
    expect(filterPorts([port], statuses, "library", "setup", "")).toEqual([port]);
    expect(summarizeLibrary([port], statuses)).toEqual({
      installed: 1,
      ready: 0,
      needsSetup: 1,
      staged: 0,
    });
  },
);

it.each([{ blockers: [] }, { blockers: ["future_blocker" as ReadinessBlocker] }])(
  "preserves a core launch refusal without recognized blockers: $blockers",
  ({ blockers }) => {
    const status = installed({
      launchable: false,
      pending_setup: false,
      blockers,
    });
    expect(portReadiness({ ...status, staged: status.active })).toBe("blocked");
  },
);

it.each([true, false])(
  "does not offer Play for a missing assessment with source requirement %s",
  (requiresSource) => {
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(
      <DetailPanel
        port={{
          ...port,
          source_profile: requiresSource ? "owned-source" : null,
        }}
        status={installed()}
        sourcePath="D:/Selected/game.z64"
        setSourcePath={vi.fn()}
        actions={actions}
      />,
    );
    const primary = host.querySelector<HTMLButtonElement>(".primary-actions button")!;
    expect(primary.disabled).toBe(true);
    expect(primary.textContent).not.toContain("Choose required source");
    expect(host.textContent).toContain("Readiness unavailable");
    expect(host.textContent).not.toContain("Ready to launch");
  },
);

it.each([undefined, null, { launchable: false, pending_setup: false, blockers: [] }])(
  "routes Continue to review without a positive core launch decision: %s",
  async (readiness) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    const root = createRoot(host);
    const launch = vi.fn();
    const details = vi.fn();
    const status = installed(readiness);
    const statuses = new Map([[port.id, status]]);
    try {
      await act(async () =>
        root.render(
          <PortBrowser
            view="library"
            ports={[port]}
            statuses={statuses}
            overview={summarizeLibrary([port], statuses)}
            recent={{ port, status }}
            filter="all"
            setFilter={vi.fn()}
            onSelect={details}
            onContinue={launch}
            loading={false}
          />,
        ),
      );
      await act(async () =>
        host
          .querySelector<HTMLButtonElement>(
            '.continue-actions [data-slot="button"][data-variant="primary"]',
          )!
          .click(),
      );
      expect(launch).not.toHaveBeenCalled();
      expect(details).toHaveBeenCalledExactlyOnceWith(
        port.id,
        `library:continue-review:${port.id}`,
      );
      expect(host.querySelector(".continue-actions")?.textContent).not.toContain("Play again");
    } finally {
      await act(async () => root.unmount());
    }
  },
);

it("restores Continue only after a new positive core assessment without changing the records", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  const launch = vi.fn();
  const details = vi.fn();
  const unknown = installed();
  const ready = installed({
    launchable: true,
    pending_setup: false,
    blockers: [],
    source: "current",
  });
  const original = JSON.stringify([unknown, ready]);
  const render = async (status: PortStatus) =>
    act(async () =>
      root.render(
        <PortBrowser
          view="library"
          ports={[port]}
          statuses={new Map([[port.id, status]])}
          overview={summarizeLibrary([port], new Map([[port.id, status]]))}
          recent={{ port, status }}
          filter="all"
          setFilter={vi.fn()}
          onSelect={details}
          onContinue={launch}
          loading={false}
        />,
      ),
    );
  try {
    await render(unknown);
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>(
          '.continue-actions [data-slot="button"][data-variant="primary"]',
        )!
        .click(),
    );
    expect(launch).not.toHaveBeenCalled();
    await render(ready);
    expect(
      host.querySelector('.continue-actions [data-slot="button"][data-variant="primary"]')
        ?.textContent,
    ).toBe("Play again");
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>(
          '.continue-actions [data-slot="button"][data-variant="primary"]',
        )!
        .click(),
    );
    expect(launch).toHaveBeenCalledExactlyOnceWith(port.id);
    expect(details).toHaveBeenCalledExactlyOnceWith(port.id, `library:continue-review:${port.id}`);
    expect(JSON.stringify([unknown, ready])).toBe(original);
  } finally {
    await act(async () => root.unmount());
  }
});

it("restores managed installation review only after an allowed snapshot", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  const held: PortStatus = {
    ...portStatus(),
    port_actions: [
      {
        action: "install",
        availability: "held",
        reason: "definition_ineligible",
        definition: { outcome: "hold", reason: "publisher_revoked" },
      },
    ],
  };
  const allowed: PortStatus = {
    ...held,
    port_actions: [{ action: "install", availability: "allowed", reason: "available" }],
  };
  const original = JSON.stringify([held, allowed]);
  const render = (status: PortStatus) =>
    act(async () =>
      root.render(
        <DetailPanel
          port={portDefinition()}
          status={status}
          sourcePath=""
          setSourcePath={vi.fn()}
          actions={actions}
        />,
      ),
    );
  try {
    await render(held);
    expect(host.querySelector<HTMLButtonElement>(".primary-actions button")!.disabled).toBe(true);
    await act(async () =>
      host.querySelector<HTMLButtonElement>(".primary-actions button")!.click(),
    );
    expect(actions.reviewInstall).not.toHaveBeenCalled();
    await render(allowed);
    expect(host.textContent).not.toContain("publisher was revoked");
    const button = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Review installation"),
    )!;
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    expect(actions.reviewInstall).toHaveBeenCalledExactlyOnceWith();
    expect(actions.install).not.toHaveBeenCalled();
    expect(JSON.stringify([held, allowed])).toBe(original);
  } finally {
    await act(async () => root.unmount());
  }
});

it.each(["missing_source", "missing_bios"] as const)(
  "keeps review of newly selected input available for core waiting reason %s",
  (reason) => {
    const selectedPort = {
      ...portDefinition(),
      source_profile: "game-profile",
      bios_source_profile: "bios-profile",
    };
    const status: PortStatus = {
      ...portStatus(),
      port_actions: [{ action: "install", availability: "waiting", reason }],
    };
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(
      <DetailPanel
        port={selectedPort}
        status={status}
        sourcePath="/owned/game"
        biosPath="/owned/bios"
        setSourcePath={vi.fn()}
        setBiosPath={vi.fn()}
        actions={actions}
      />,
    );
    const button = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Review installation"),
    )!;
    expect(button.disabled).toBe(false);
    expect(host.textContent).not.toContain("Setup unavailable");
  },
);

it("keeps malformed current setup availability from opening an installation review", () => {
  const status = { ...portStatus(), port_actions: null } as unknown as PortStatus;
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(
    <DetailPanel
      port={portDefinition()}
      status={status}
      sourcePath=""
      setSourcePath={vi.fn()}
      actions={actions}
    />,
  );
  expect(host.textContent).toContain(
    "Current setup availability is unavailable. Refresh the workspace to check again.",
  );
  expect(
    [...host.querySelectorAll("button")].some(
      (button) => !button.disabled && button.textContent?.includes("Review installation"),
    ),
  ).toBe(false);
});

it("explains an unoffered managed platform without asking for game files", () => {
  const host = document.createElement("div");
  const status: PortStatus = {
    ...portStatus(),
    port_actions: [
      { action: "install", availability: "not_offered", reason: "unsupported_platform" },
    ],
  };
  host.innerHTML = renderToStaticMarkup(
    <DetailPanel
      port={portDefinition()}
      status={status}
      sourcePath=""
      setSourcePath={vi.fn()}
      actions={actions}
    />,
  );
  expect(host.textContent).toContain("This route is unavailable on this platform.");
  expect(host.querySelector<HTMLButtonElement>(".primary-actions button")!.disabled).toBe(true);
  expect(host.textContent).not.toContain("Choose required game files");
});

const ownedInstallPlan: InstallPlan = {
  bundled_runtime: null,
  port_id: "sample",
  channel: "stable",
  platform: "windows-x86-64",
  action: "download",
  source_requirements: [],
  download_bytes: 64,
  release: {
    published_at: null,
    version: "2",
    channel: "stable",
    asset: {
      name: "owned.zip",
      url: "https://example.invalid/owned.zip",
      size: 64,
      sha256: "a".repeat(64),
    },
  },
  storage: {
    library_root: "/owned/library",
    volume_total_bytes: 1024,
    volume_available_bytes: 512,
  },
  output_location: {
    configured_output_directory: null,
    port_id: "sample",
    library_root: "/owned/library",
    default_output_directory: "/owned/library/versions/sample",
    effective_output_directory: "/owned/library/versions/sample",
    selection_source: "library_default",
    user_data_root: "/owned/library/user/sample",
  },
};

it("lets a held existing review be dismissed before an allowed snapshot returns", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const dismiss = vi.fn();
  const allowed: PortStatus = {
    ...portStatus(),
    port_actions: [{ action: "install", availability: "allowed", reason: "available" }],
  };
  const held: PortStatus = {
    ...allowed,
    port_actions: [
      {
        action: "install",
        availability: "held",
        reason: "definition_ineligible",
        definition: { outcome: "hold", reason: "publisher_revoked" },
      },
    ],
  };
  function Harness({ status }: { status: PortStatus }) {
    const [plan, setPlan] = useState<InstallPlan | undefined>(ownedInstallPlan);
    return (
      <DetailPanel
        port={portDefinition()}
        status={status}
        installPlan={plan}
        sourcePath=""
        setSourcePath={vi.fn()}
        actions={{
          ...actions,
          dismissInstallReview: (expected?: unknown) => {
            if (expected !== undefined) {
              dismiss(expected);
              return;
            }
            dismiss();
            setPlan(undefined);
          },
        }}
      />
    );
  }
  const render = (status: PortStatus) => act(async () => root.render(<Harness status={status} />));
  try {
    await render(allowed);
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    await render(held);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    const cancel = [...host.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Cancel review",
    );
    expect(cancel).toBeDefined();
    expect(cancel!.disabled).toBe(false);
    await act(async () => cancel!.click());
    expect(dismiss).toHaveBeenCalledExactlyOnceWith();
    await render(allowed);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(
      [...host.querySelectorAll("button")].some(
        (button) => !button.disabled && button.textContent?.includes("Review installation"),
      ),
    ).toBe(true);
    expect(actions.install).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("passes no click event when cancelling an ordinary installation review", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const dismissed = vi.fn();
  function Harness() {
    const [plan, setPlan] = useState<InstallPlan | undefined>(ownedInstallPlan);
    return (
      <DetailPanel
        port={portDefinition()}
        status={{
          ...portStatus(),
          port_actions: [{ action: "install", availability: "allowed", reason: "available" }],
        }}
        installPlan={plan}
        sourcePath=""
        setSourcePath={vi.fn()}
        actions={{
          ...actions,
          dismissInstallReview: (expected?: unknown) => {
            if (expected !== undefined) {
              dismissed(expected);
              return;
            }
            dismissed();
            setPlan(undefined);
          },
        }}
      />
    );
  }
  try {
    await act(async () => root.render(<Harness />));
    const cancel = [
      ...document.body.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
    ].find((button) => button.textContent?.trim() === "Cancel review");
    expect(cancel).toBeDefined();
    await act(async () => cancel!.click());
    expect(dismissed).toHaveBeenCalledExactlyOnceWith();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("keeps an owned installation cancellation reachable when setup becomes held", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  const cancel = vi
    .spyOn(desktopApi, "cancelOperation")
    .mockResolvedValue({ phase: "preparing", requested: true });
  const activity: ActivityRecord = {
    id: "owned-install-operation",
    operation: "install",
    target_id: "sample",
    target_kind: "port",
    status: "running",
    started_at: 1,
    finished_at: null,
    message: null,
    failure: null,
    cancellation: { phase: "preparing", requested: false },
  };
  const status: PortStatus = {
    ...portStatus(),
    port_actions: [
      {
        action: "install",
        availability: "held",
        reason: "definition_ineligible",
        definition: { outcome: "hold", reason: "publisher_revoked" },
      },
    ],
  };
  try {
    await act(async () =>
      root.render(
        <DetailPanel
          port={portDefinition()}
          status={status}
          installPlan={ownedInstallPlan}
          cancellableActivities={[activity]}
          busy="install"
          sourcePath=""
          setSourcePath={vi.fn()}
          actions={actions}
        />,
      ),
    );
    const button = [...host.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Cancel operation",
    )!;
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    expect(cancel).toHaveBeenCalledExactlyOnceWith(activity.id);
    expect(host.textContent).toContain("Cancellation requested");
    expect(actions.install).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    cancel.mockRestore();
  }
});

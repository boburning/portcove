import { controlledAct as act } from "../../test/controlled-react-act";
import { render as renderComponent, cleanup, type RenderResult } from "vitest-browser-react";

import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { desktopApi } from "../api";
import { pickInstallFolder } from "../file-picker";
import { failureReport, portDefinition, portStatus } from "../test-fixtures";
import type { ExternalRuntimeRecord } from "../types";
import { ExternalRuntimeControl } from "./ExternalRuntime";
import { ActionReviewFailure } from "./ActionReviewFailure";

vi.mock("../file-picker", () => ({ pickInstallFolder: vi.fn() }));

const port = {
  ...portDefinition(),
  release: { ...portDefinition().release, provider: "user-prepared" as const },
  presentation: {
    installation_method: "user-prepared-runtime" as const,
    source_requirements: [],
    saves_and_settings: "external-user-owned" as const,
    manual_preparation: "Create an empty portable.txt beside the executable.",
  },
};
const record: ExternalRuntimeRecord = {
  id: "external-1",
  port_id: port.id,
  path: "C:\\Player\\WaveRace",
  executable: "C:\\Player\\WaveRace\\game.exe",
  version: "1.0.2",
  platform: "windows-x86-64",
  archive_sha256: "a".repeat(64),
  immutable_tree_sha256: "b".repeat(64),
  registered_at: 1,
};
let root: RenderResult;
let host: HTMLDivElement;

beforeEach(async () => {
  host = document.createElement("div");
  document.body.append(host);
  root = await renderComponent(null, { container: document.body.appendChild(host) });
});
afterEach(async () => {
  await cleanup();
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function click(label: string) {
  const buttons = [...document.body.querySelectorAll("button")];
  const matching = (item: HTMLButtonElement) => item.textContent?.trim() === label;
  const button =
    buttons.find((item) => item.closest('[data-slot="dialog-content"]') && matching(item)) ??
    buttons.find(matching);
  expect(button).toBeDefined();
  await act(async () => button?.click());
}

it("shows authored steps and essential warnings while preserving detailed notes behind disclosure", async () => {
  const open = vi.spyOn(desktopApi, "openExternalUrl").mockResolvedValue(undefined);
  const register = vi.spyOn(desktopApi, "registerExternalRuntime");
  const guided = {
    ...port,
    presentation: {
      ...port.presentation,
      manual_preparation: "Exact compatibility, ownership and developer-option notes.",
      manual_setup: {
        steps: [
          { title: "Prepare a working copy", instruction: "Keep your original unchanged." },
          { title: "Review the folder", instruction: "Choose the prepared folder below." },
        ],
        warnings: ["Preserve the existing pilot; do not overwrite it."],
        help_url: "https://example.com/guide",
      },
    },
  };
  await root.rerender(
    <ExternalRuntimeControl port={guided} status={portStatus()} generation={9} busy={false} />,
  );
  const section = host.querySelector('[aria-label="Prepare this port"]')!;
  expect(section.querySelectorAll("ol > li")).toHaveLength(2);
  expect(section.textContent).toContain("You need your own original game files");
  const warning = section.querySelector("aside")!;
  expect(warning.textContent).toContain("Preserve the existing pilot");
  expect(warning.closest("details")).toBeNull();
  const notes = [...section.querySelectorAll("details")].find((element) =>
    element.textContent?.includes("developer-option notes"),
  );
  expect(notes?.open).toBe(false);
  const help = section.querySelector<HTMLAnchorElement>("a")!;
  expect(help.textContent).toBe("Detailed preparation guide");
  await act(async () => help.click());
  expect(open).toHaveBeenCalledExactlyOnceWith("https://example.com/guide");
  expect(register).not.toHaveBeenCalled();
  expect(pickInstallFolder).not.toHaveBeenCalled();
});

it("reviews an exact player-owned folder before registering it", async () => {
  vi.mocked(pickInstallFolder).mockResolvedValue(record.path);
  const preview = vi.spyOn(desktopApi, "previewExternalRuntime").mockResolvedValue({
    port_id: port.id,
    path: record.path,
    executable: record.executable,
    version: record.version,
    archive_sha256: record.archive_sha256,
    immutable_tree_sha256: record.immutable_tree_sha256,
    immutable_file_count: 17,
    preview_sha256: "reviewed-external",
  });
  const register = vi.spyOn(desktopApi, "registerExternalRuntime").mockResolvedValue(record);
  const changed = vi.fn();
  await root.rerender(
    <ExternalRuntimeControl
      port={port}
      status={portStatus()}
      generation={7}
      busy={false}
      onChanged={changed}
    />,
  );
  await click("Choose game folder");
  expect(document.body.textContent).toContain("Create an empty portable.txt");
  expect(preview).toHaveBeenCalledExactlyOnceWith(port.id, record.path, 7);
  expect(document.body.textContent).toContain(record.executable);
  expect(register).not.toHaveBeenCalled();
  await click("Use this installation");
  expect(register).toHaveBeenCalledExactlyOnceWith(port.id, record.path, "reviewed-external", 7);
  expect(changed).toHaveBeenCalledOnce();
});

it("removes only the external registration through the separate reviewed action", async () => {
  vi.spyOn(desktopApi, "previewExternalRemoval").mockResolvedValue({
    port_id: port.id,
    path: record.path,
    version: record.version,
    external_files_will_be_preserved: true,
    preview_sha256: "reviewed-removal",
  });
  const remove = vi.spyOn(desktopApi, "removeExternalRuntime").mockResolvedValue(record);
  const managedUninstall = vi.spyOn(desktopApi, "remove");
  const changed = vi.fn();
  await root.rerender(
    <ExternalRuntimeControl
      port={port}
      status={{ ...portStatus(), external_runtime: record }}
      generation={7}
      busy={false}
      onChanged={changed}
    />,
  );
  await click("Stop using this installation");
  expect(document.body.textContent).toContain("The files stay where they are, including");
  await click("Stop using this installation");
  expect(remove).toHaveBeenCalledExactlyOnceWith(port.id, "reviewed-removal", 7);
  expect(managedUninstall).not.toHaveBeenCalled();
  expect(changed).toHaveBeenCalledOnce();
});

it("explains a held external registration before opening a folder picker", async () => {
  const picker = vi.mocked(pickInstallFolder);
  await root.rerender(
    <ExternalRuntimeControl
      port={port}
      status={{
        ...portStatus(),
        port_actions: [
          {
            action: "register_external",
            availability: "held",
            reason: "definition_ineligible",
            definition: { outcome: "hold", reason: "publisher_revoked" },
          },
        ],
      }}
      generation={7}
      busy={false}
    />,
  );
  expect(document.body.textContent).toContain(
    "Setup is on hold. The catalog publisher was revoked.",
  );
  expect(document.body.querySelector("button")?.disabled).toBe(true);
  expect(picker).not.toHaveBeenCalled();
});

it("does not invent a cause for an unknown external route hold", async () => {
  await root.rerender(
    <ExternalRuntimeControl
      port={port}
      status={{
        ...portStatus(),
        port_actions: [
          {
            action: "register_external",
            availability: "held",
            reason: "definition_ineligible",
            definition: { outcome: "hold", reason: "future_reason" as never },
          },
        ],
      }}
      generation={7}
      busy={false}
    />,
  );
  expect(document.body.textContent).toContain(
    "Setup status unknown. View details for current requirements.",
  );
  expect(document.body.textContent).not.toContain("future_reason");
});

const otherPort = { ...port, id: "another-external-port", name: "Another game" };

it.each([
  ["missing status", undefined],
  ["partial actions", [{ action: "install", availability: "allowed", reason: "available" }]],
  [
    "duplicate actions",
    [
      { action: "register_external", availability: "waiting", reason: "review_required" },
      { action: "register_external", availability: "not_offered", reason: "unsupported_platform" },
    ],
  ],
  [
    "unknown availability",
    [{ action: "register_external", availability: "future", reason: "review_required" }],
  ],
  [
    "contradictory definition",
    [
      {
        action: "register_external",
        availability: "waiting",
        reason: "review_required",
        definition: { outcome: "hold", reason: "publisher_revoked" },
      },
    ],
  ],
] as const)("does not open the picker for %s", async (name, actions) => {
  const picker = vi.mocked(pickInstallFolder);
  const preview = vi.spyOn(desktopApi, "previewExternalRuntime");
  await root.rerender(
    <ExternalRuntimeControl
      port={port}
      status={
        name === "missing status" ? undefined : { ...portStatus(), port_actions: actions as never }
      }
      generation={7}
      busy={false}
    />,
  );
  expect(document.body.textContent).toContain(
    "Setup status unknown. View details for current requirements.",
  );
  expect(document.body.querySelector("button")?.disabled).toBe(true);
  await click("Choose game folder");
  expect(picker).not.toHaveBeenCalled();
  expect(preview).not.toHaveBeenCalled();
});

it.each([undefined, []] as const)("preserves the legacy %s projection", async (actions) => {
  await root.rerender(
    <ExternalRuntimeControl
      port={port}
      status={{ ...portStatus(), port_actions: actions as never }}
      generation={7}
      busy={false}
    />,
  );
  expect(document.body.querySelector("button")?.disabled).toBe(false);
});

it("recovers from a missing current route when a fresh review assessment arrives", async () => {
  const render = (actions: NonNullable<ReturnType<typeof portStatus>["port_actions"]>) =>
    root.rerender(
      <ExternalRuntimeControl
        port={port}
        status={{ ...portStatus(), port_actions: actions }}
        generation={7}
        busy={false}
      />,
    );
  await render([{ action: "install", availability: "allowed", reason: "available" }]);
  expect(document.body.querySelector("button")?.disabled).toBe(true);
  await render([
    { action: "register_external", availability: "waiting", reason: "review_required" },
  ]);
  expect(document.body.querySelector("button")?.disabled).toBe(false);
  vi.mocked(pickInstallFolder).mockResolvedValue(record.path);
  const preview = vi
    .spyOn(desktopApi, "previewExternalRuntime")
    .mockResolvedValue(runtimePreview());
  const register = vi.spyOn(desktopApi, "registerExternalRuntime");
  await click("Choose game folder");
  expect(preview).toHaveBeenCalledExactlyOnceWith(port.id, record.path, 7);
  expect(register).not.toHaveBeenCalled();
});

function runtimePreview() {
  return {
    port_id: port.id,
    path: record.path,
    executable: record.executable,
    version: record.version,
    archive_sha256: record.archive_sha256,
    immutable_tree_sha256: record.immutable_tree_sha256,
    immutable_file_count: 17,
    preview_sha256: "reviewed-external",
  };
}

it.each(["port", "library", "away-and-back"] as const)(
  "discards a delayed folder choice after a %s context change",
  async (change) => {
    let resolvePicker!: (path: string) => void;
    vi.mocked(pickInstallFolder).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePicker = resolve;
        }),
    );
    const preview = vi
      .spyOn(desktopApi, "previewExternalRuntime")
      .mockResolvedValue(runtimePreview());
    const register = vi.spyOn(desktopApi, "registerExternalRuntime");
    const render = (selectedPort = port, generation = 7) =>
      root.rerender(
        <ExternalRuntimeControl
          port={selectedPort}
          status={portStatus()}
          generation={generation}
          busy={false}
        />,
      );
    await render();
    await click("Choose game folder");
    if (change === "library") await render(port, 8);
    else await render(otherPort);
    if (change === "away-and-back") await render();
    await act(async () => resolvePicker(record.path));
    expect(document.body.querySelector('[data-slot="dialog-content"]')).toBeNull();
    expect(preview).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  },
);

it("closes an existing registration review instead of reviewing another game's folder", async () => {
  vi.mocked(pickInstallFolder).mockResolvedValue(record.path);
  const preview = vi
    .spyOn(desktopApi, "previewExternalRuntime")
    .mockResolvedValue(runtimePreview());
  const register = vi.spyOn(desktopApi, "registerExternalRuntime");
  const render = (selectedPort = port) =>
    root.rerender(
      <ExternalRuntimeControl
        port={selectedPort}
        status={portStatus()}
        generation={7}
        busy={false}
      />,
    );
  await render();
  await click("Choose game folder");
  expect(preview).toHaveBeenCalledExactlyOnceWith(port.id, record.path, 7);
  await render(otherPort);
  expect(document.body.querySelector('[data-slot="dialog-content"]')).toBeNull();
  expect(preview).toHaveBeenCalledOnce();
  expect(register).not.toHaveBeenCalled();
});

it.each(["library", "registration"] as const)(
  "closes a removal review when its %s context changes",
  async (change) => {
    const preview = vi.spyOn(desktopApi, "previewExternalRemoval").mockResolvedValue({
      port_id: port.id,
      path: record.path,
      version: record.version,
      external_files_will_be_preserved: true,
      preview_sha256: "reviewed-removal",
    });
    const remove = vi.spyOn(desktopApi, "removeExternalRuntime");
    const render = (generation = 7, external = record) =>
      root.rerender(
        <ExternalRuntimeControl
          port={port}
          status={{ ...portStatus(), external_runtime: external }}
          generation={generation}
          busy={false}
        />,
      );
    await render();
    await click("Stop using this installation");
    expect(preview).toHaveBeenCalledExactlyOnceWith(port.id, 7);
    await render(
      change === "library" ? 8 : 7,
      change === "registration" ? { ...record, id: "replacement-registration" } : record,
    );
    expect(document.body.querySelector('[data-slot="dialog-content"]')).toBeNull();
    expect(preview).toHaveBeenCalledOnce();
    expect(remove).not.toHaveBeenCalled();
  },
);

it.each(["same context", "new context"] as const)(
  "does not replace a fresh review with a late picker from the %s",
  async (context) => {
    let resolveOldPicker!: (path: string) => void;
    vi.mocked(pickInstallFolder)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOldPicker = resolve;
          }),
      )
      .mockResolvedValueOnce("C:\\Player\\FreshRuntime");
    const preview = vi
      .spyOn(desktopApi, "previewExternalRuntime")
      .mockResolvedValue(runtimePreview());
    const register = vi.spyOn(desktopApi, "registerExternalRuntime");
    const render = (selectedPort = port) =>
      root.rerender(
        <ExternalRuntimeControl
          port={selectedPort}
          status={portStatus()}
          generation={7}
          busy={false}
        />,
      );
    await render();
    await click("Choose game folder");
    const currentPort = context === "new context" ? otherPort : port;
    if (context === "new context") await render(currentPort);
    await click("Choose game folder");
    expect(preview).toHaveBeenCalledExactlyOnceWith(currentPort.id, "C:\\Player\\FreshRuntime", 7);
    await act(async () => resolveOldPicker(record.path));
    expect(preview).toHaveBeenCalledOnce();
    expect(document.body.querySelector('[data-slot="dialog-content"]')?.textContent).toContain(
      currentPort.name,
    );
    expect(register).not.toHaveBeenCalled();
  },
);

it("discards a folder choice after the control is unmounted", async () => {
  let resolvePicker!: (path: string) => void;
  vi.mocked(pickInstallFolder).mockImplementation(
    () =>
      new Promise((resolve) => {
        resolvePicker = resolve;
      }),
  );
  const preview = vi.spyOn(desktopApi, "previewExternalRuntime");
  await root.rerender(
    <ExternalRuntimeControl port={port} status={portStatus()} generation={7} busy={false} />,
  );
  await click("Choose game folder");
  await root.rerender(null);
  await act(async () => resolvePicker(record.path));
  expect(preview).not.toHaveBeenCalled();
  expect(document.body.querySelector('[data-slot="dialog-content"]')).toBeNull();
});

it("keeps a cancelled current folder choice out of review", async () => {
  vi.mocked(pickInstallFolder).mockResolvedValue(null);
  const preview = vi.spyOn(desktopApi, "previewExternalRuntime");
  await root.rerender(
    <ExternalRuntimeControl port={port} status={portStatus()} generation={7} busy={false} />,
  );
  await click("Choose game folder");
  expect(preview).not.toHaveBeenCalled();
  expect(document.body.querySelector('[data-slot="dialog-content"]')).toBeNull();
});

it.each(
  [
    [{ action: "launch", availability: "allowed", reason: "available" }],
    [
      {
        action: "remove_external",
        availability: "waiting",
        reason: "review_required",
        definition: { outcome: "hold", reason: "publisher_revoked" },
      },
    ],
    [{ action: "remove_external", availability: "allowed", reason: "available" }],
    [
      { action: "remove_external", availability: "waiting", reason: "review_required" },
      { action: "remove_external", availability: "not_offered", reason: "not_installed" },
    ],
  ].map((actions, index) => ({
    name: ["missing route", "definition hold", "wrong tuple", "duplicate"][index],
    actions,
  })),
)("does not open removal for $name", async ({ actions }) => {
  const preview = vi.spyOn(desktopApi, "previewExternalRemoval");
  await root.rerender(
    <ExternalRuntimeControl
      port={port}
      status={{ ...portStatus(), external_runtime: record, port_actions: actions as never }}
      generation={7}
      busy={false}
    />,
  );
  const stop = [...document.body.querySelectorAll("button")].find(
    (button) => button.textContent === "Stop using this installation",
  );
  expect(stop?.disabled).toBe(true);
  await click("Stop using this installation");
  expect(preview).not.toHaveBeenCalled();
  expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  expect(document.body.textContent).toContain("Current removal availability is unavailable");
});

it.each([
  ["not_started", "This operation did not start."],
  ["no_changes", "No files were changed by this operation."],
  ["committed", "The change was saved. Check the result before trying again."],
  ["recovery_required", "An earlier attempt left unfinished work."],
  ["unknown", "Portcove couldn't confirm whether anything changed."],
] as const)(
  "preserves the reported %s outcome and makes Check again read-only",
  async (state, text) => {
    vi.mocked(pickInstallFolder).mockResolvedValue(record.path);
    const preview = vi
      .spyOn(desktopApi, "previewExternalRuntime")
      .mockResolvedValue(runtimePreview());
    const failure = failureReport();
    failure.presentation.mutation_state = state;
    failure.presentation.summary =
      "Check this runtime's current registration before another attempt.";
    failure.presentation.phase = "registration_readback";
    failure.presentation.technical_context = { port_id: port.id };
    const register = vi.spyOn(desktopApi, "registerExternalRuntime").mockRejectedValue(failure);
    await root.rerender(
      <ExternalRuntimeControl port={port} status={portStatus()} generation={7} busy={false} />,
    );
    await click("Choose game folder");
    await click("Use this installation");
    const alert = document.body.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain(failure.presentation.summary);
    expect(alert?.textContent).toContain(text);
    expect(alert?.textContent).toContain("View technical details");
    expect(alert?.textContent).toContain("registration_readback");
    expect(alert?.textContent).toContain(failure.code);
    expect(document.body.querySelector("button")?.textContent).not.toBe("Use this installation");
    await click("Check again");
    expect(preview).toHaveBeenCalledTimes(2);
    expect(register).toHaveBeenCalledOnce();
    expect(document.body.querySelector('[role="alert"]')).toBeNull();
  },
);

it("announces only a proven neutral cancellation as status", async () => {
  vi.mocked(pickInstallFolder).mockResolvedValue(record.path);
  const failure = failureReport();
  failure.code = "cancelled";
  failure.presentation.tone = "neutral";
  failure.presentation.mutation_state = "no_changes";
  failure.presentation.summary = "The operation was cancelled.";
  vi.spyOn(desktopApi, "previewExternalRuntime").mockRejectedValue(failure);
  await root.rerender(
    <ExternalRuntimeControl port={port} status={portStatus()} generation={7} busy={false} />,
  );
  await click("Choose game folder");
  expect(document.body.querySelector('[role="alert"]')).toBeNull();
  expect(document.body.querySelector('[role="status"]')?.textContent).toContain(
    "The operation was cancelled.",
  );
  expect(document.body.querySelector('[role="status"]')?.textContent).toContain(
    "No files were changed",
  );
});

it("keeps future and legacy failure outcomes unknown", async () => {
  const future = failureReport();
  const value = {
    ...future,
    presentation: { ...future.presentation, mutation_state: "future_outcome", tone: "neutral" },
  };
  await root.rerender(<ActionReviewFailure error={value} />);
  expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
    "Portcove couldn't confirm whether anything changed.",
  );
  expect(document.body.textContent).not.toContain("No files were changed");
  await root.rerender(<ActionReviewFailure error={new Error("Read current state again.")} />);
  expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(
    "Read current state again.",
  );
  expect(document.body.textContent).not.toContain("No files were changed");
});

// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { desktopApi } from "../api";
import { pickInstallFolder } from "../file-picker";
import { portDefinition, portStatus } from "../test-fixtures";
import type { ExternalRuntimeRecord } from "../types";
import { ExternalRuntimeControl } from "./ExternalRuntime";

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
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
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
  await act(async () =>
    root.render(
      <ExternalRuntimeControl
        port={port}
        status={portStatus()}
        generation={7}
        busy={false}
        onChanged={changed}
      />,
    ),
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
  await act(async () =>
    root.render(
      <ExternalRuntimeControl
        port={port}
        status={{ ...portStatus(), external_runtime: record }}
        generation={7}
        busy={false}
        onChanged={changed}
      />,
    ),
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
  await act(async () =>
    root.render(
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
    ),
  );
  expect(document.body.textContent).toContain(
    "Setup is on hold. The catalog publisher was revoked.",
  );
  expect(document.body.querySelector("button")?.disabled).toBe(true);
  expect(picker).not.toHaveBeenCalled();
});

it("does not invent a cause for an unknown external route hold", async () => {
  await act(async () =>
    root.render(
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
    ),
  );
  expect(document.body.textContent).toContain(
    "Setup is on hold. Check this port's current requirements.",
  );
  expect(document.body.textContent).not.toContain("future_reason");
});

const otherPort = { ...port, id: "another-external-port", name: "Another game" };

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
      act(async () =>
        root.render(
          <ExternalRuntimeControl
            port={selectedPort}
            status={portStatus()}
            generation={generation}
            busy={false}
          />,
        ),
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
    act(async () =>
      root.render(
        <ExternalRuntimeControl
          port={selectedPort}
          status={portStatus()}
          generation={7}
          busy={false}
        />,
      ),
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
      act(async () =>
        root.render(
          <ExternalRuntimeControl
            port={port}
            status={{ ...portStatus(), external_runtime: external }}
            generation={generation}
            busy={false}
          />,
        ),
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
      act(async () =>
        root.render(
          <ExternalRuntimeControl
            port={selectedPort}
            status={portStatus()}
            generation={7}
            busy={false}
          />,
        ),
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
  await act(async () =>
    root.render(
      <ExternalRuntimeControl port={port} status={portStatus()} generation={7} busy={false} />,
    ),
  );
  await click("Choose game folder");
  await act(async () => root.render(null));
  await act(async () => resolvePicker(record.path));
  expect(preview).not.toHaveBeenCalled();
  expect(document.body.querySelector('[data-slot="dialog-content"]')).toBeNull();
});

it("keeps a cancelled current folder choice out of review", async () => {
  vi.mocked(pickInstallFolder).mockResolvedValue(null);
  const preview = vi.spyOn(desktopApi, "previewExternalRuntime");
  await act(async () =>
    root.render(
      <ExternalRuntimeControl port={port} status={portStatus()} generation={7} busy={false} />,
    ),
  );
  await click("Choose game folder");
  expect(preview).not.toHaveBeenCalled();
  expect(document.body.querySelector('[data-slot="dialog-content"]')).toBeNull();
});

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
  await click("Choose existing runtime");
  expect(document.body.textContent).toContain("Create an empty portable.txt");
  expect(preview).toHaveBeenCalledExactlyOnceWith(port.id, record.path, 7);
  expect(document.body.textContent).toContain(record.executable);
  expect(register).not.toHaveBeenCalled();
  await click("Register runtime");
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
  await click("Remove registration");
  expect(document.body.textContent).toContain("Every external game, setting, and save file");
  await click("Remove registration");
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
  expect(document.body.textContent).toContain("Registration held: publisher revoked");
  expect(document.body.querySelector("button")?.disabled).toBe(true);
  expect(picker).not.toHaveBeenCalled();
});

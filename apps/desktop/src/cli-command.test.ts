import { portDefinition, portStatus } from "./test-fixtures";
import { describe, expect, it } from "vitest";
import { primaryCliCommand, quoteCliArg } from "./cli-command";
import type { PortDefinition, PortStatus } from "./types";

const port: PortDefinition = {
  ...portDefinition(),
  id: "sample-port",
  name: "Sample",
  summary: "Sample",
  project_url: "https://example.com",
  support_tier: "stable",
  channels: ["stable", "beta"],
  platforms: ["windows-x86-64"],
  automated_tested_platforms: [],
  manually_validated_platforms: [],
  adapter: "staged-source-portable",
  source_profile: "sample-source",
  bios_source_profile: "sample-bios",
  persistent_paths: [],
  upstream_status: "active",
  release: portDefinition().release,
  executable_hints: {},
};

const context = {
  executable: "C:/Program Files/Portcove/portcove.exe",
  library_root: "E:/My Library",
  platform: "windows-x86-64",
} as const;

describe("GUI to CLI continuity", () => {
  it("binds setup to the selected library, release channel and original files", () => {
    const command = primaryCliCommand(
      context,
      port,
      undefined,
      "beta",
      "D:/ROMs/Sample Game.z64",
      "D:/BIOS/sample.bin",
    );
    expect(command.args).toEqual([
      "--library",
      "E:/My Library",
      "--json",
      "--non-interactive",
      "ensure",
      "sample-port",
      "--channel",
      "beta",
      "--source",
      "D:/ROMs/Sample Game.z64",
      "--bios",
      "D:/BIOS/sample.bin",
    ]);
    expect(command.shell).toContain(
      "& 'C:/Program Files/Portcove/portcove.exe' --library 'E:/My Library'",
    );
    expect(command.missing).toEqual([]);
  });

  it("launches the active installation with the exact library and no ensure operation", () => {
    const status = { ...portStatus(), active: { id: "active" } } as PortStatus;
    const command = primaryCliCommand(context, port, status, "stable");
    expect(command.args).toEqual(["--library", "E:/My Library", "exec", "sample-port", "--"]);
    expect(command.missing).toEqual([]);
  });

  it("labels unavailable executables and missing originals as templates", () => {
    const command = primaryCliCommand({ ...context, executable: null }, port, undefined, "stable");
    expect(command.missing).toEqual(["Portcove CLI executable", "source-path", "bios-path"]);
    expect(command.args).toContain("<source-path>");
    expect(command.shell).toContain("'<portcove-executable>'");
  });

  it("rejects null characters instead of producing truncated arguments", () => {
    expect(() => quoteCliArg("bad\0path", "posix")).toThrow(/null/);
  });
});

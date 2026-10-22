import { portDefinition, portStatus } from "./test-fixtures";
import { describe, expect, it } from "vite-plus/test";
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

  it("uses the exact external folder preview and registration route for a user-prepared port", () => {
    const prepared = {
      ...port,
      release: { ...port.release, provider: "user-prepared" as const },
    };
    const command = primaryCliCommand(context, prepared, undefined, "stable");
    expect(command.args).toEqual([
      "--library",
      "E:/My Library",
      "external",
      "preview",
      "sample-port",
      "<game-folder>",
    ]);
    expect(command.followUp?.args).toEqual([
      "--library",
      "E:/My Library",
      "external",
      "register",
      "sample-port",
      "<game-folder>",
    ]);
    expect(command.missing).toContain("game-folder");
    expect(command.args).not.toContain("ensure");
    const registered = primaryCliCommand(
      context,
      prepared,
      { ...portStatus(), external_runtime: { id: "external" } } as PortStatus,
      "stable",
    );
    expect(registered.args).toEqual(["--library", "E:/My Library", "exec", "sample-port", "--"]);
  });

  it("rejects null characters instead of producing truncated arguments", () => {
    expect(() => quoteCliArg("bad\0path", "posix")).toThrow(/null/);
  });

  it("copies explicit executable review and fingerprint-bound registration for user-managed setup", () => {
    const selectedPort: PortDefinition = {
      ...port,
      source_profile: null,
      bios_source_profile: null,
      release: {
        ...port.release,
        provider: "user-prepared",
        user_prepared: {
          "windows-x86-64": {
            trust: "user-selected",
            version: "user-managed",
            archive_name: "",
            archive_size: 0,
            archive_sha256: "",
            immutable_tree_sha256: "",
            executable: "",
            mutable_paths: [],
            source_argument_extension: null,
          },
        },
      },
    };
    const command = primaryCliCommand(context, selectedPort, undefined, "stable");
    expect(command.args).toEqual([
      "--library",
      context.library_root,
      "external",
      "select-preview",
      port.id,
      "<game-executable>",
      "--working-directory",
      "<working-directory>",
    ]);
    expect(command.followUp?.args).toEqual([
      "--library",
      context.library_root,
      "external",
      "select",
      port.id,
      "<game-executable>",
      "--working-directory",
      "<working-directory>",
      "--expected-preview",
      "<review-sha256>",
    ]);
    expect(command.missing).toEqual(["game-executable", "working-directory"]);
    expect(command.args).not.toContain("preview");
    expect(command.followUp?.args).not.toContain("register");
  });
});

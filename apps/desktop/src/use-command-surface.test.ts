import { describe, expect, it, vi } from "vitest";
import { portDefinition, portStatus } from "./test-fixtures";
import { commandSurfaceCommands } from "./use-command-surface";

function commands(recent = true) {
  const actions = {
    setView: vi.fn(),
    setAdoptOpen: vi.fn(),
    setSelectedId: vi.fn(),
  };
  return {
    actions,
    commands: commandSurfaceCommands({
      recent: recent ? { port: portDefinition(), status: portStatus() } : undefined,
      installedCount: 1,
      busy: false,
      ...actions,
      checkAll: vi.fn(async () => undefined),
      focusSearch: vi.fn(),
    }),
  };
}

describe("command surface player-facing copy", () => {
  it("describes copying an existing installation without exposing the internal operation name", () => {
    const { actions, commands: available } = commands();
    const command = available.find(({ id }) => id === "adopt");
    expect(command).toMatchObject({
      label: "Copy an existing installation",
      description: "Review and copy a supported installation into Portcove",
    });
    expect(`${command?.label} ${command?.description}`.toLowerCase()).not.toContain("adopt");
    command?.action();
    expect(actions.setAdoptOpen).toHaveBeenCalledWith(true);
  });

  it("describes opening the last played port and keeps the unavailable state disabled", () => {
    const { actions, commands: available } = commands();
    const command = available.find(({ id }) => id === "continue");
    expect(command).toMatchObject({
      label: "Open the last played port",
      description: "Open Sample",
      disabled: false,
    });
    command?.action();
    expect(actions.setSelectedId).toHaveBeenCalledWith("sample");
    expect(commands(false).commands.find(({ id }) => id === "continue")).toMatchObject({
      label: "Open the last played port",
      description: "No successful launch is recorded yet",
      disabled: true,
    });
  });
});

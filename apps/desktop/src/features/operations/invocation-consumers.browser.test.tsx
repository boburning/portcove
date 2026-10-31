import { controlledAct as act } from "../../../test/controlled-react-act";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { desktopApi } from "../../api";
import { Channel } from "@tauri-apps/api/core";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { detailActions } from "../game-details/detail-actions";
import { installRecord } from "../../components/rendered-test-fixtures";
import { StatusLayer } from "../../components/Chrome";
import { portDefinition, sourceProfile } from "../../test-fixtures";
import { targetInvocationContext } from "./invocation-state";
import { useOperationState } from "./use-operation-state";
import { useInstallPlanning, useAdoptionPlanning } from "../installation/use-installation-planning";
import { useGithubAuth } from "../github-auth/use-github-auth";
import { addRequiredSource, replaceRegisteredSource } from "../source-health/source-actions";
import { pickSourcePath } from "../../file-picker";
import type { BackupRecord, OperationEvent, PortDefinition, SourceRecord } from "../../types";

vi.mock("@tauri-apps/api/event", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/event")>()),
  listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("../../file-picker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../file-picker")>()),
  pickSourcePath: vi.fn(),
  pickSourceArchivePath: vi.fn(),
}));
const port: PortDefinition = {
  ...portDefinition(),
  name: "Shipwright",
  presentation: {
    original_game_title: "Ocarina of Time",
    variant_label: null,
    installation_method: "portable-package",
    source_requirements: [],
    saves_and_settings: "portcove-managed",
  },
};
const profile = { ...sourceProfile(), label: "Ocarina of Time game files" };
let root: Root, host: HTMLDivElement;
let state!: ReturnType<typeof useOperationState>;
let install!: ReturnType<typeof useInstallPlanning>;
let adoption!: ReturnType<typeof useAdoptionPlanning>;
let auth!: ReturnType<typeof useGithubAuth>;
let details!: ReturnType<typeof detailActions>;
const refresh = vi.fn<() => Promise<unknown>>();
const closeDetail = vi.fn();
const backupsChanged = vi.fn<() => Promise<void>>();
const openActivity = vi.fn();
function Fixture({ generation = 7 }: { generation?: number }) {
  state = useOperationState({
    refresh,
    libraryGeneration: generation,
    libraryLabel: "E:/private/library",
  });
  details = detailActions({
    port,
    status: undefined,
    sourcePath: "",
    biosPath: "",
    perform: state.perform,
    close: closeDetail,
    backupsChanged,
    libraryGeneration: generation,
  });
  install = useInstallPlanning(
    port.id,
    "stable",
    state.perform,
    targetInvocationContext(
      "Review installation",
      { kind: "port", id: port.id, label: "Ocarina of Time · Shipwright" },
      generation,
      "library",
    ),
  );
  adoption = useAdoptionPlanning(
    "E:/existing",
    port.id,
    true,
    generation,
    state.perform,
    () => {},
    [port],
  );
  auth = useGithubAuth(state.perform, state.setError, generation);
  return (
    <StatusLayer
      invocations={state.invocations}
      dismissInvocation={state.dismissInvocation}
      clearError={() => state.setError(undefined)}
      operationEvents={state.operationEvents}
      openActivity={openActivity}
    />
  );
}
beforeEach(async () => {
  refresh.mockReset().mockResolvedValue(undefined);
  backupsChanged.mockReset().mockResolvedValue(undefined);
  closeDetail.mockReset();
  openActivity.mockReset();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(desktopApi, "githubAuthStatus").mockResolvedValue({
    authenticated: false,
    device_login_available: true,
    login: null,
    rate_limit: null,
    source: "anonymous",
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Fixture />));
});

const backup: BackupRecord = {
  id: "backup-a",
  port_id: port.id,
  path: "library/backups/a",
  created_at: 1,
  file_count: 1,
  size: 12,
  sha256: "a".repeat(64),
};

it.each(["remove", "deleteBackup", "restoreBackup"] as const)(
  "settles declined native %s through the action, invocation and announcement owners",
  async (action) => {
    vi.spyOn(desktopApi, action).mockResolvedValue(null);
    let result: unknown;
    await act(async () => {
      result =
        action === "remove"
          ? await details.remove("reviewed")
          : await details[action](backup, "reviewed");
    });
    expect(result).toBe("cancelled");
    expect([...state.invocations.values()]).toMatchObject([
      {
        phase: "settled",
        outcome: "cancelled",
        context: { libraryGeneration: 7, target: { id: port.id } },
      },
    ]);
    expect(host.textContent).toContain("cancelled.");
    expect(host.textContent).not.toContain("finished.");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(closeDetail).not.toHaveBeenCalled();
    expect(backupsChanged).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledOnce();
  },
);

it.each(["remove", "deleteBackup", "restoreBackup"] as const)(
  "settles confirmed native %s with successful readback",
  async (action) => {
    vi.spyOn(desktopApi, "remove").mockResolvedValue(["owned-install"]);
    vi.spyOn(desktopApi, "deleteBackup").mockResolvedValue(backup);
    vi.spyOn(desktopApi, "restoreBackup").mockResolvedValue({
      restored_backup: backup,
      safety_backup: null,
    });
    await act(async () => {
      if (action === "remove") await details.remove("reviewed");
      else await details[action](backup, "reviewed");
    });
    expect([...state.invocations.values()][0]?.outcome).toBe("succeeded");
    expect(host.textContent).toContain("finished.");
    expect(host.textContent).not.toContain("cancelled.");
    expect(refresh).toHaveBeenCalledOnce();
    expect(closeDetail).toHaveBeenCalledTimes(action === "remove" ? 1 : 0);
    expect(backupsChanged).toHaveBeenCalledTimes(action === "remove" ? 0 : 1);
  },
);

it("retains a successful nullable-consent result independently from failed readback", async () => {
  vi.spyOn(desktopApi, "deleteBackup").mockResolvedValue(backup);
  refresh.mockRejectedValue(new Error("Readback unavailable"));
  await act(async () => {
    await details.deleteBackup(backup, "reviewed");
  });
  expect([...state.invocations.values()]).toMatchObject([
    { phase: "settled", outcome: "succeeded" },
  ]);
  expect([...state.invocations.values()][0]?.refreshFailure).toBeInstanceOf(Error);
  expect(host.textContent).toContain("Action finished; current state could not be refreshed");
  expect(backupsChanged).toHaveBeenCalledOnce();
});

it("does not classify an unrelated null command as declined native consent", async () => {
  await act(async () => {
    await state.perform("optional lookup", async () => null);
  });
  expect([...state.invocations.values()][0]?.outcome).toBe("succeeded");
  expect(host.textContent).toContain("finished.");
});

it("binds an ordinary install's owned root during unrelated work and ignores late events", async () => {
  let finish!: (result: ReturnType<typeof installRecord>) => void;
  let report!: (event: OperationEvent) => void;
  mockIPC((command, args) => {
    if (
      command !== "install_port" ||
      !args ||
      Array.isArray(args) ||
      !("onEvent" in args) ||
      !(args.onEvent instanceof Channel)
    )
      throw new Error("Expected the ordinary install IPC with its owned event channel");
    const channel = args.onEvent;
    report = (event) => channel.onmessage(event);
    return new Promise<ReturnType<typeof installRecord>>((resolve) => {
      finish = resolve;
    });
  });
  let releaseOther!: () => void;
  let other!: Promise<unknown>;
  let installing!: ReturnType<typeof details.install>;
  await act(async () => {
    installing = details.install();
    other = state.perform(
      "verify unrelated",
      () =>
        new Promise<void>((resolve) => {
          releaseOther = resolve;
        }),
      {
        context: targetInvocationContext(
          "Verify",
          { kind: "port", id: "other", label: "Other game" },
          7,
        ),
      },
    );
  });
  const started: OperationEvent = {
    schema_version: 2,
    operation_id: "actual-install-root",
    parent_operation_id: null,
    target: null,
    sequence: 1,
    timestamp_ms: 1,
    operation: "install",
    type: "started",
  };
  expect(
    [...state.invocations.values()].find((record) => record.name === "install")?.context.activityId,
  ).toBeUndefined();
  await act(async () => {
    report({ ...started, operation_id: "child", parent_operation_id: started.operation_id });
    report(started);
    report({
      ...started,
      type: "progress",
      sequence: 3,
      phase: "download",
      completed: 2,
      total: 4,
    });
    report({
      ...started,
      type: "progress",
      sequence: 2,
      phase: "download",
      completed: 1,
      total: 4,
    });
  });
  expect(state.operationEvents.get(started.operation_id)?.sequence).toBe(3);
  const records = [...state.invocations.values()];
  expect(records.find((record) => record.name === "install")?.context.activityId).toBe(
    started.operation_id,
  );
  expect(
    records.find((record) => record.name === "verify unrelated")?.context.activityId,
  ).toBeUndefined();
  const destination = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "View task in Activity",
  )!;
  await act(async () => destination.click());
  expect(openActivity).toHaveBeenCalledExactlyOnceWith(started.operation_id);
  await act(async () => {
    finish(installRecord());
    await installing;
  });
  await act(async () => {
    report({ ...started, operation_id: "late-root" });
  });
  expect(state.operationEvents.has("late-root")).toBe(false);
  expect(records.find((record) => record.name === "install")?.context.activityId).toBe(
    started.operation_id,
  );
  await act(async () => {
    releaseOther();
    await other;
  });
});

it("attributes an ordinary install failed start before an activity identity exists", async () => {
  vi.spyOn(desktopApi, "install").mockRejectedValue(new Error("Install inputs changed"));
  await act(async () => {
    await details.install();
  });
  expect([...state.invocations.values()]).toMatchObject([
    { name: "install", outcome: "failed", phase: "settled", context: { target: { id: port.id } } },
  ]);
  expect([...state.invocations.values()][0]?.context.activityId).toBeUndefined();
  expect(host.textContent).toContain("Install inputs changed");
  expect(host.textContent).not.toContain("finished.");
});

it("does not publish an ordinary install's late events or outcome into a replacement library", async () => {
  let finish!: (result: ReturnType<typeof installRecord>) => void;
  let report!: (event: OperationEvent) => void;
  vi.spyOn(desktopApi, "install").mockImplementation(
    (_port, _channel, _source, _bios, _stage, _generation, accept) => {
      report = accept!;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  );
  let installing!: ReturnType<typeof details.install>;
  await act(async () => {
    installing = details.install();
  });
  await act(async () => root.render(<Fixture generation={8} />));
  await act(async () => {
    report({
      schema_version: 2,
      operation_id: "outgoing-install",
      parent_operation_id: null,
      target: null,
      sequence: 1,
      timestamp_ms: 1,
      operation: "install",
      type: "started",
    });
    finish(installRecord());
    await installing;
  });
  expect(state.invocations.size).toBe(0);
  expect(state.operationEvents.size).toBe(0);
  expect(host.textContent).not.toContain("finished.");
  expect(refresh).not.toHaveBeenCalled();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearMocks();
});
it("attributes failed installation review before an Activity ID exists and keeps library exclusion", async () => {
  let reject!: (error: Error) => void;
  vi.spyOn(desktopApi, "plan").mockReturnValue(
    new Promise((_, fail) => {
      reject = fail;
    }),
  );
  let pending!: Promise<void>;
  await act(async () => {
    pending = install.review();
  });
  const other = vi.fn().mockResolvedValue(null);
  await act(async () => {
    await state.perform("launch", other, {
      context: targetInvocationContext(
        "Launch game",
        { kind: "port", id: "other", label: "Other game" },
        7,
      ),
    });
  });
  expect(other).not.toHaveBeenCalled();
  await act(async () => {
    reject(new Error("Release could not be checked"));
    await pending;
  });
  const record = [...state.invocations.values()].find((entry) => entry.name === "review install")!;
  expect(record.context).toMatchObject({
    action: "Review installation",
    target: { label: "Ocarina of Time · Shipwright" },
    exclusionScope: "library",
  });
  expect(record.context.activityId).toBeUndefined();
  expect(
    [...host.querySelectorAll('[role="alert"]')].map((alert) => alert.textContent).join(" "),
  ).toContain("Review installation · Ocarina of Time · Shipwright");
  expect(host.textContent).not.toContain("E:/private/library");
});
it("does not publish an outgoing review failure into a replacement library", async () => {
  let reject!: (error: Error) => void;
  vi.spyOn(desktopApi, "plan").mockReturnValue(
    new Promise((_, fail) => {
      reject = fail;
    }),
  );
  let pending!: Promise<void>;
  await act(async () => {
    pending = install.review();
  });
  await act(async () => root.render(<Fixture generation={8} />));
  await act(async () => {
    reject(new Error("Outgoing failure"));
    await pending;
  });
  expect(install.plan).toBeUndefined();
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
it.each(["add", "relink"] as const)(
  "attributes %s failures to the selected game-file requirements",
  async (action) => {
    vi.mocked(pickSourcePath).mockResolvedValue("E:/chosen.z64");
    vi.spyOn(desktopApi, "addSource").mockRejectedValue(new Error("File rejected"));
    vi.spyOn(desktopApi, "planSourceRelink").mockRejectedValue(new Error("File rejected"));
    await act(async () => {
      if (action === "add")
        await addRequiredSource(profile, false, "game", state.perform, state.setError, 7);
      else
        await replaceRegisteredSource(
          profile,
          {
            profile_id: profile.id,
            path: "E:/old.z64",
            sha256: "a".repeat(64),
            size: 1,
            storage_sha256: "a".repeat(64),
            storage_size: 1,
            updated_at: 1,
          } satisfies SourceRecord,
          "game",
          state.perform,
          state.setError,
          7,
        );
    });
    const record = [...state.invocations.values()][0]!;
    expect(record.context).toMatchObject({
      target: { kind: "source", id: profile.id, label: profile.label },
      libraryGeneration: 7,
      exclusionScope: "library",
    });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(profile.label);
  },
);
it("attributes an existing-installation review to its game without claiming an Activity identity", async () => {
  vi.spyOn(desktopApi, "previewAdoption").mockRejectedValue(
    new Error("Not a recognized installation"),
  );
  await act(async () => adoption.review());
  expect([...state.invocations.values()][0]?.context).toMatchObject({
    action: "Review existing installation",
    target: { kind: "port", label: "Ocarina of Time · Shipwright" },
    exclusionScope: "library",
  });
});
it.each(["saveToken", "logout", "beginDeviceLogin"] as const)(
  "attributes %s failures to the application account",
  async (action) => {
    vi.spyOn(desktopApi, "setGithubToken").mockRejectedValue(new Error("Account unavailable"));
    vi.spyOn(desktopApi, "logoutGithub").mockRejectedValue(new Error("Account unavailable"));
    vi.spyOn(desktopApi, "beginGithubDeviceLogin").mockRejectedValue(
      new Error("Account unavailable"),
    );
    await act(async () => auth[action]());
    expect([...state.invocations.values()][0]?.context).toMatchObject({
      target: { kind: "application", id: "github-account", label: "GitHub account" },
      libraryGeneration: 7,
      exclusionScope: "application",
    });
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("GitHub account");
  },
);
it("does not submit a file picked for an outgoing library", async () => {
  let accept!: (path: string) => void;
  vi.mocked(pickSourcePath).mockReturnValue(
    new Promise((resolve) => {
      accept = resolve;
    }),
  );
  const add = vi.spyOn(desktopApi, "addSource");
  let pending!: Promise<void>;
  await act(async () => {
    pending = addRequiredSource(profile, false, "game", state.perform, state.setError, 7);
  });
  await act(async () => root.render(<Fixture generation={8} />));
  await act(async () => {
    accept("E:/chosen.z64");
    await pending;
  });
  expect(add).not.toHaveBeenCalled();
  expect(state.invocations.size).toBe(0);
});
it("treats cancelled source selection as neutral without an invocation", async () => {
  vi.mocked(pickSourcePath).mockResolvedValue(null);
  const add = vi.spyOn(desktopApi, "addSource");
  await act(async () =>
    addRequiredSource(profile, false, "game", state.perform, state.setError, 7),
  );
  expect(add).not.toHaveBeenCalled();
  expect(state.invocations.size).toBe(0);
});

it.each(["add", "relink"] as const)(
  "attributes %s picker failure without replacing it with an exclusion conflict",
  async (action) => {
    let complete!: (value: Awaited<ReturnType<typeof desktopApi.plan>>) => void;
    vi.spyOn(desktopApi, "plan").mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    let pending!: Promise<void>;
    await act(async () => {
      pending = install.review();
    });
    vi.mocked(pickSourcePath).mockRejectedValue(new Error("Picker could not open"));
    await act(async () => {
      if (action === "add")
        await addRequiredSource(profile, false, "game", state.perform, state.setError, 7);
      else
        await replaceRegisteredSource(
          profile,
          {
            profile_id: profile.id,
            path: "E:/old.z64",
            sha256: "a".repeat(64),
            size: 1,
            storage_sha256: "a".repeat(64),
            storage_size: 1,
            updated_at: 1,
          },
          "game",
          state.perform,
          state.setError,
          7,
        );
    });
    const failure = [...state.invocations.values()].find((record) => record.failure)!;
    expect(failure.failure).toBe("Picker could not open");
    expect(failure.context).toMatchObject({
      target: { id: profile.id, label: profile.label },
      libraryGeneration: 7,
      exclusionScope: "library",
    });
    expect(failure.context.activityId).toBeUndefined();
    expect(state.pendingOperations.size).toBe(1);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(profile.label);
    await act(async () => {
      complete({} as Awaited<ReturnType<typeof desktopApi.plan>>);
      await pending;
    });
  },
);
it("names a missing requirements profile truthfully without opening the picker", async () => {
  vi.mocked(pickSourcePath).mockClear();
  await act(async () =>
    replaceRegisteredSource(
      undefined,
      {
        profile_id: "removed-profile",
        path: "E:/old.z64",
        sha256: "a".repeat(64),
        size: 1,
        storage_sha256: "a".repeat(64),
        storage_size: 1,
        updated_at: 1,
      },
      "game",
      state.perform,
      state.setError,
      7,
    ),
  );
  expect(pickSourcePath).not.toHaveBeenCalled();
  expect([...state.invocations.values()][0]?.context).toMatchObject({
    action: "Update game-file location",
    target: { kind: "source", id: "removed-profile", label: "Selected game-file location" },
  });
});
it("drops a picker error from an outgoing library", async () => {
  let fail!: (error: Error) => void;
  vi.mocked(pickSourcePath).mockReturnValue(
    new Promise((_, reject) => {
      fail = reject;
    }),
  );
  let pending!: Promise<void>;
  await act(async () => {
    pending = addRequiredSource(profile, false, "game", state.perform, state.setError, 7);
  });
  await act(async () => root.render(<Fixture generation={8} />));
  await act(async () => {
    fail(new Error("Outgoing picker failure"));
    await pending;
  });
  expect(state.invocations.size).toBe(0);
});
it("attributes account-status failures on initial read and explicit refresh", async () => {
  vi.mocked(desktopApi.githubAuthStatus).mockRejectedValue(new Error("Account status unavailable"));
  await act(async () => root.render(<Fixture generation={8} />));
  await act(async () => auth.refresh());
  const records = [...state.invocations.values()];
  expect(records).toHaveLength(2);
  for (const record of records) {
    expect(record.context).toMatchObject({
      action: "Check account status",
      target: { label: "GitHub account" },
      libraryGeneration: 8,
      exclusionScope: "application",
    });
    expect(record.context.activityId).toBeUndefined();
  }
  expect(host.querySelectorAll('[role="alert"]')).toHaveLength(2);
});
it("does not publish an outgoing account-status failure", async () => {
  let fail!: (error: Error) => void;
  vi.mocked(desktopApi.githubAuthStatus).mockReturnValueOnce(
    new Promise((_, reject) => {
      fail = reject;
    }),
  );
  let pending!: Promise<void>;
  await act(async () => {
    pending = auth.refresh();
  });
  await act(async () => root.render(<Fixture generation={8} />));
  await act(async () => {
    fail(new Error("Outgoing account failure"));
    await pending;
  });
  expect(state.invocations.size).toBe(0);
});
it.each([false, true])(
  "attributes a device-login poll failure only to its current owner (replacement %s)",
  async (replace) => {
    vi.useFakeTimers();
    vi.spyOn(desktopApi, "beginGithubDeviceLogin").mockResolvedValue({
      expires_at: 60,
      interval_seconds: 1,
      session_id: "synthetic-session",
      user_code: "TEST",
      verification_uri: "https://github.com/login/device",
    });
    let fail!: (error: Error) => void;
    vi.spyOn(desktopApi, "pollGithubDeviceLogin").mockReturnValue(
      new Promise((_, reject) => {
        fail = reject;
      }),
    );
    await act(async () => auth.beginDeviceLogin());
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    if (replace) await act(async () => root.render(<Fixture generation={8} />));
    await act(async () => {
      fail(new Error("Device login unavailable"));
      await Promise.resolve();
    });
    const failures = [...state.invocations.values()].filter((record) => record.failure);
    expect(failures.map((record) => record.context)).toEqual(
      replace
        ? []
        : [
            targetInvocationContext(
              "Sign in",
              { kind: "application", id: "github-account", label: "GitHub account" },
              7,
              "application",
            ),
          ],
    );
    expect(
      [...host.querySelectorAll('[role="alert"]')].map((alert) =>
        alert.textContent?.includes("Sign in · GitHub account"),
      ),
    ).toEqual(replace ? [] : [true]);
  },
);
it("rejects a supplied stale context even through the current error setter", async () => {
  await act(async () =>
    state.setError(
      "Old failure",
      targetInvocationContext(
        "Add game files",
        { kind: "source", id: profile.id, label: profile.label },
        6,
        "library",
      ),
    ),
  );
  expect(state.invocations.size).toBe(0);
});

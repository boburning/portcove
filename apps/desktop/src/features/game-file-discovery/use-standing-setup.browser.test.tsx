import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { desktopApi } from "../../api";
import { requestStandingSetup, useStandingSetupCatchUp } from "./use-standing-setup";

const emptyPass: Awaited<ReturnType<typeof desktopApi.runStandingSetup>> = {
  already_running: false,
  assessments: [],
  not_assessed: 0,
  batches: [],
  failures: [],
};

const catalog = {};
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.createElement("div"));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function CatchUp({ onChanged = async () => {} }: { onChanged?: () => Promise<unknown> }) {
  useStandingSetupCatchUp(1, true, catalog, "", onChanged);
  return null;
}

it("runs the shared pass for automatic mods alone when Desktop opens", async () => {
  const pass = vi.spyOn(desktopApi, "runStandingSetup").mockResolvedValue({
    ...emptyPass,
    mod_updates: [
      {
        port_id: "shipwright",
        profile_id: "setup",
        profile_name: "Custom",
        native_ids: ["textures.o2r"],
        outcome: "applied",
        file_id: "11",
        revision: 3,
      },
    ],
  });
  const onChanged = vi.fn(async () => {});
  const intents = vi.spyOn(desktopApi, "portIntents").mockResolvedValue([]);
  const folders = vi.spyOn(desktopApi, "rootSetupConsents").mockResolvedValue([]);
  await act(async () => root.render(<CatchUp onChanged={onChanged} />));
  await act(async () => vi.advanceTimersByTimeAsync(1_500));
  expect(pass).toHaveBeenCalledExactlyOnceWith(1, expect.any(Function));
  expect(intents).not.toHaveBeenCalled();
  expect(folders).not.toHaveBeenCalled();
  expect(onChanged).toHaveBeenCalledOnce();
});

it("retries a deferred mod update once soon and wakes on a library or setup change", async () => {
  const pass = vi.spyOn(desktopApi, "runStandingSetup").mockResolvedValue({
    ...emptyPass,
    mod_updates: [
      {
        port_id: "shipwright",
        profile_id: "setup",
        profile_name: "Custom",
        native_ids: ["textures.o2r"],
        outcome: "deferred",
        reason: "the game is running",
      },
    ],
  });
  await act(async () => root.render(<CatchUp />));
  await act(async () => vi.advanceTimersByTimeAsync(1_500));
  expect(pass).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(pass).toHaveBeenCalledTimes(2);
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(pass).toHaveBeenCalledTimes(2);
  requestStandingSetup();
  await act(async () => vi.advanceTimersByTimeAsync(1_500));
  expect(pass).toHaveBeenCalledTimes(3);
});

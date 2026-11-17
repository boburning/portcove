import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { initializeLocalization } from "../../localization";
import type { PortDefinition, PortStatus } from "../../types";
import { portDefinition } from "../../test-fixtures";
import { InvocationOwnerProvider } from "../operations/invocation-owner";
import { OperationPresentationProvider } from "../operations/operation-presentation";
import { useOperationState } from "../operations/use-operation-state";
import { targetInvocationContext } from "../operations/invocation-state";
import { GroupedDiscover } from "./GroupedDiscover";

vi.mock("@tauri-apps/api/event", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/event")>()),
  listen: vi.fn().mockResolvedValue(() => {}),
}));

let root: Root;
let host: HTMLDivElement;
const i18n = initializeLocalization();

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await i18n.changeLanguage("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  await i18n.changeLanguage("en");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("updates shared card translations and pending actions without remounting the card", async () => {
  const port: PortDefinition = {
    ...portDefinition(),
    channels: ["beta"],
    platforms: ["linux-x86-64"],
    upstream_status: "retired",
  };
  const ports = [port];
  const statuses = new Map<string, PortStatus>();
  const onSelect = vi.fn();
  const onFavoriteToggle = vi.fn();
  const onTask = vi.fn();
  const refresh = vi.fn().mockResolvedValue(undefined);
  let state!: ReturnType<typeof useOperationState>;
  function Fixture() {
    state = useOperationState({ refresh, libraryGeneration: 7 });
    return (
      <OperationPresentationProvider generation={7} pending={state.pendingOperations}>
        <GroupedDiscover
          all={ports}
          matching={ports}
          statuses={statuses}
          devicePlatform="windows-x86-64"
          onSelect={onSelect}
          onFavoriteToggle={onFavoriteToggle}
          onTask={onTask}
        />
      </OperationPresentationProvider>
    );
  }
  await act(async () =>
    root.render(
      <InvocationOwnerProvider>
        <Fixture />
      </InvocationOwnerProvider>,
    ),
  );
  const card = host.querySelector("article")!;
  const action = card.querySelector<HTMLButtonElement>(".discover-game-actions button")!;
  const idleLabel = action.textContent;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let running!: Promise<unknown>;
  await act(async () => {
    running = state.perform("prepare", () => done, {
      context: {
        ...targetInvocationContext("Prepare", { kind: "port", id: port.id, label: port.name }, 7),
        activityId: "owned-task",
      },
    });
  });
  expect(action.textContent).toBe(i18n.t("discover.action.task", { ns: "browsing" }));
  const englishTask = action.textContent;
  await act(async () => {
    await i18n.changeLanguage("ar-XB");
  });
  expect(host.querySelector("article")).toBe(card);
  expect(action.textContent).not.toBe(englishTask);
  expect(action.textContent).toBe(i18n.t("discover.action.task", { ns: "browsing" }));
  expect(card.querySelector(".discover-game-metadata")?.textContent).toContain(
    i18n.t("discover.unavailableFor", { ns: "browsing", platform: "Windows" }),
  );
  expect(card.querySelector(".discover-game-metadata [title]")?.getAttribute("title")).toBe(
    i18n.t("discover.chip.channel", { ns: "browsing" }),
  );
  expect(card.querySelector(".discover-observations")?.textContent).toContain(
    i18n.t("observations.retired", { ns: "browsing" }),
  );
  await act(async () => action.click());
  expect(onTask).toHaveBeenCalledWith("owned-task");
  await act(async () => {
    finish();
    await running;
    await i18n.changeLanguage("en");
  });
  expect(host.querySelector("article")).toBe(card);
  expect(action.textContent).toBe(idleLabel);
});

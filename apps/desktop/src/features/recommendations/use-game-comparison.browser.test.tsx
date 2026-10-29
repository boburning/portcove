import { controlledAct as act } from "../../../test/controlled-react-act";
import { cleanup, render } from "vitest-browser-react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { desktopApi } from "../../api";
import type { GameComparison } from "../../types";
import { useGameComparison } from "./use-game-comparison";
import { comparisonFixture } from "./comparison-test-fixture";

let state!: ReturnType<typeof useGameComparison>;
function Fixture({
  portId = "sample",
  generation = 1,
  observationKey = "unchanged",
}: {
  portId?: string;
  generation?: number;
  observationKey?: string;
}) {
  state = useGameComparison({ portId, generation, observationKey });
  return null;
}
afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

it("reuses an unchanged query and refreshes only the explicitly requested observation", async () => {
  const read = vi.spyOn(desktopApi, "compareGamePorts").mockResolvedValue(comparisonFixture());
  const root = await render(<Fixture />);
  expect(read).toHaveBeenCalledTimes(1);
  expect(read.mock.calls[0]?.[0].refresh).toBe(false);
  await root.rerender(<Fixture />);
  expect(read).toHaveBeenCalledTimes(1);
  await act(async () => state.refresh());
  expect(read).toHaveBeenCalledTimes(2);
  expect(read.mock.calls[1]?.[0].refresh).toBe(true);
  await root.rerender(<Fixture observationKey="accepted-release-change" />);
  expect(read).toHaveBeenCalledTimes(3);
  expect(read.mock.calls[2]?.[0].refresh).toBe(false);
});

it("ignores stale library and context answers and resets context for another library", async () => {
  const pending: ((report: GameComparison) => void)[] = [];
  const read = vi
    .spyOn(desktopApi, "compareGamePorts")
    .mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
  const root = await render(<Fixture />);
  await act(async () =>
    state.setContext((context) => ({ ...context, requirements: ["multiplayer"] })),
  );
  expect(read).toHaveBeenCalledTimes(2);
  await act(async () => pending[0]!(comparisonFixture("old-context")));
  expect(state.report).toBeUndefined();
  await act(async () => pending[1]!(comparisonFixture("current-context")));
  expect(state.report?.ports[0]?.port_id).toBe("current-context");
  await root.rerender(<Fixture generation={2} />);
  expect(state.context.requirements).toEqual([]);
  expect(state.report).toBeUndefined();
  expect(read.mock.calls.at(-1)?.[1]).toBe(2);
  await root.rerender(<Fixture portId="different" generation={2} />);
  await act(async () => pending[2]!(comparisonFixture("old-library-project")));
  expect(state.report).toBeUndefined();
  await act(async () => pending[3]!(comparisonFixture("different")));
  expect(state.report?.ports[0]?.port_id).toBe("different");
});

it("withholds recommendations on unavailable or future optional results and supports retry", async () => {
  const read = vi
    .spyOn(desktopApi, "compareGamePorts")
    .mockResolvedValue(comparisonFixture("sample", { format_version: 2 }));
  await render(<Fixture />);
  expect(state.failed).toBe(true);
  expect(state.report).toBeUndefined();
  read.mockRejectedValue(new Error("fixture private error should not be displayed"));
  await act(async () => state.refresh());
  expect(state.failed).toBe(true);
  expect(state.report).toBeUndefined();
  read.mockResolvedValue(comparisonFixture());
  await act(async () => state.refresh());
  expect(state.failed).toBe(false);
  expect(state.report?.ports[0]?.port_id).toBe("sample");
});

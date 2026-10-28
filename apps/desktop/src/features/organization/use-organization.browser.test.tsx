import { controlledAct as act } from "../../../test/controlled-react-act";
import { cleanup, render } from "vitest-browser-react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { desktopApi } from "../../api";
import type { LibraryOrganization } from "../../types";
import { useOrganization } from "./use-organization";

const empty: LibraryOrganization = {
  revision: 0,
  collections: {},
  hidden_port_ids: [],
  saved_game_ids: [],
  update_notices: {},
  setup_confirmations: [],
};
let state!: ReturnType<typeof useOrganization>;
function Fixture({ generation = 1 }: { generation?: number }) {
  state = useOrganization(generation);
  return null;
}
afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

it("retains confirmed choices on stale or failed writes and refreshes explicitly", async () => {
  vi.spyOn(desktopApi, "organizationPreferences").mockResolvedValue(empty);
  const write = vi
    .spyOn(desktopApi, "changeOrganization")
    .mockRejectedValue(new Error("stale revision"));
  await render(<Fixture />);
  await act(async () => state.commit({ kind: "set_hidden", port_id: "port", hidden: true }));
  expect(write).toHaveBeenCalledWith(0, { kind: "set_hidden", port_id: "port", hidden: true }, 1);
  expect(state.snapshot).toEqual(empty);
  expect(state.failure).toBe("write");
  const current = { ...empty, revision: 2, hidden_port_ids: ["other-port"] };
  vi.mocked(desktopApi.organizationPreferences).mockResolvedValue(current);
  await act(async () => state.refresh());
  expect(state.snapshot).toEqual(current);
  expect(state.failure).toBeUndefined();
});

it("ignores delayed writes for an old library and serializes local requests", async () => {
  vi.spyOn(desktopApi, "organizationPreferences").mockImplementation(async (generation) => ({
    ...empty,
    revision: generation,
  }));
  let resolve!: (snapshot: LibraryOrganization) => void;
  const pending = new Promise<LibraryOrganization>((yes) => {
    resolve = yes;
  });
  const write = vi.spyOn(desktopApi, "changeOrganization").mockReturnValue(pending);
  const root = await render(<Fixture />);
  let committed!: Promise<boolean>;
  await act(async () => {
    committed = state.commit({ kind: "set_saved", game_id: "game", saved: true });
    expect(await state.commit({ kind: "set_saved", game_id: "other", saved: true })).toBe(false);
  });
  expect(write).toHaveBeenCalledTimes(1);
  await root.rerender(<Fixture generation={2} />);
  await act(async () => {
    resolve({ ...empty, revision: 2, saved_game_ids: ["game"] });
    await committed;
  });
  expect(state.snapshot?.saved_game_ids).toEqual([]);
  expect(state.snapshot?.revision).toBe(2);
});

it("never writes after an unreadable preference load", async () => {
  vi.spyOn(desktopApi, "organizationPreferences").mockRejectedValue(
    new Error("invalid preferences"),
  );
  const write = vi.spyOn(desktopApi, "changeOrganization");
  await render(<Fixture />);
  expect(state.snapshot).toBeUndefined();
  expect(state.failure).toBe("read");
  await act(async () => state.commit({ kind: "set_hidden", port_id: "port", hidden: true }));
  expect(write).not.toHaveBeenCalled();
});

it("exposes a new library's read failure and allows an explicit retry", async () => {
  const read = vi.spyOn(desktopApi, "organizationPreferences").mockResolvedValue(empty);
  const root = await render(<Fixture />);
  read.mockRejectedValue(new Error("new library preferences unreadable"));
  await root.rerender(<Fixture generation={2} />);
  expect(state.snapshot).toBeUndefined();
  expect(state.busy).toBe(false);
  expect(state.failure).toBe("read");
  read.mockResolvedValue({ ...empty, revision: 3 });
  await act(async () => state.refresh());
  expect(read).toHaveBeenLastCalledWith(2);
  expect(state.snapshot?.revision).toBe(3);
  expect(state.failure).toBeUndefined();
});

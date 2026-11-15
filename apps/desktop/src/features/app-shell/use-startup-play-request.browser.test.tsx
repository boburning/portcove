import { renderHook, cleanup } from "vitest-browser-react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { desktopApi } from "../../api";
import { installedLaunchStatus, portDefinition } from "../../test-fixtures";
import type { PortStatus } from "../../types";
import type { CatalogEntry } from "../browsing/catalog-entry";
import { useStartupPlayRequest } from "./use-startup-play-request";

const port = portDefinition();
const playable = installedLaunchStatus({ launchable: true, blockers: [], pending_setup: false });

function setup(status: PortStatus, ready = false) {
  const play = vi.fn<(port: CatalogEntry) => void>();
  const openDetails = vi.fn<(portId: string) => void>();
  const props = (isReady: boolean) => ({
    ready: isReady,
    entries: [port],
    statuses: new Map([[port.id, status]]),
    play,
    openDetails,
  });
  return { play, openDetails, props, initial: props(ready) };
}

describe("startup play request", () => {
  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
  });

  it("waits for the workspace, takes the request once and plays a ready game", async () => {
    const take = vi.spyOn(desktopApi, "takeStartupPlayRequest").mockResolvedValue(port.id);
    const { play, openDetails, props, initial } = setup(playable);
    const view = await renderHook((value = initial) => useStartupPlayRequest(value), {
      initialProps: initial,
    });
    expect(take).not.toHaveBeenCalled();
    await view.act(async () => view.rerender(props(true)));
    await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(1));
    expect(play).toHaveBeenCalledWith(port);
    await view.act(async () => view.rerender(props(true)));
    expect(take).toHaveBeenCalledTimes(1);
    expect(openDetails).not.toHaveBeenCalled();
  });

  it("opens details when the game needs attention", async () => {
    vi.spyOn(desktopApi, "takeStartupPlayRequest").mockResolvedValue(port.id);
    const blocked = installedLaunchStatus({
      launchable: false,
      blockers: ["missing_source"],
      pending_setup: false,
    });
    const { play, openDetails, props } = setup(blocked);
    await renderHook((value = props(true)) => useStartupPlayRequest(value), {
      initialProps: props(true),
    });
    await vi.waitFor(() => expect(openDetails).toHaveBeenCalledWith(port.id));
    expect(play).not.toHaveBeenCalled();
  });

  it("opens the app normally when there is no request or it cannot be read", async () => {
    const outcomes = [() => Promise.resolve(null), () => Promise.reject(new Error("unavailable"))];
    for (const outcome of outcomes) {
      const take = vi.spyOn(desktopApi, "takeStartupPlayRequest").mockImplementation(outcome);
      const { play, openDetails, props } = setup(playable);
      await renderHook((value = props(true)) => useStartupPlayRequest(value), {
        initialProps: props(true),
      });
      await vi.waitFor(() => expect(take).toHaveBeenCalledTimes(1));
      await Promise.resolve();
      expect(play).not.toHaveBeenCalled();
      expect(openDetails).not.toHaveBeenCalled();
      await cleanup();
      vi.restoreAllMocks();
    }
  });

  it("takes a request forwarded by a later launch and routes it the same way", async () => {
    const take = vi
      .spyOn(desktopApi, "takeStartupPlayRequest")
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(port.id);
    let announce: (() => void) | undefined;
    const unlisten = vi.fn();
    const listen = vi.fn((_name: string, accept: () => void) => {
      announce = accept;
      return Promise.resolve(unlisten);
    }) as unknown as NonNullable<Parameters<typeof useStartupPlayRequest>[0]["listen"]>;
    const { play, props } = setup(playable);
    const view = await renderHook(
      (value = { ...props(true), listen }) => useStartupPlayRequest(value),
      { initialProps: { ...props(true), listen } },
    );
    await vi.waitFor(() => expect(take).toHaveBeenCalledTimes(1));
    expect(play).not.toHaveBeenCalled();
    expect(listen).toHaveBeenCalledWith("portcove://play-request", expect.any(Function));
    await vi.waitFor(() => expect(announce).toBeDefined());
    await view.act(async () => announce?.());
    await vi.waitFor(() => expect(play).toHaveBeenCalledWith(port));
    expect(take).toHaveBeenCalledTimes(2);
    await view.unmount();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});

// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { portStatus } from "../test-fixtures";
import type { PortStatus, ReleaseChannel } from "../types";
import { ReleaseChannelControl } from "./ReleaseChannel";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function click(text: string) {
  const button = [...document.querySelectorAll("button")].find(item => item.textContent === text);
  expect(button).toBeDefined(); await act(async () => button?.click());
}
const saved = { ...portStatus(), channel: "rolling" as const };

it.each(["stable", "beta", "rolling"] as ReleaseChannel[])("renders %s-only availability without a selector or mutation", async channel => {
  const change = vi.fn(); const refresh = vi.fn();
  await act(async () => root.render(<ReleaseChannelControl channels={[channel]} selected={channel} busy={false} change={change} refresh={refresh} />));
  expect(container.textContent).toContain(`${channel[0].toUpperCase()}${channel.slice(1)} only`);
  expect(container.querySelector("button")).toBeNull(); expect(change).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled();
});

it.each(["rolling", "beta"] as const)("saves a real %s choice before refreshing release data", async next => {
  const calls: string[] = [];
  const change = vi.fn(async () => { calls.push("save"); return { ...saved, channel: next }; });
  const refresh = vi.fn(async () => { calls.push("check"); return {}; });
  await act(async () => root.render(<ReleaseChannelControl channels={["stable", next]} selected="stable" busy={false} change={change} refresh={refresh} />));
  await click("Release channelStable"); await click(next === "rolling" ? "Rolling" : "Beta");
  expect(change).toHaveBeenCalledExactlyOnceWith(next); expect(calls).toEqual(["save", "check"]);
  expect(container.textContent).toContain("Release information refreshed");
});

it("keeps failed metadata refresh distinct from a saved channel", async () => {
  const change = vi.fn().mockResolvedValue(saved); const refresh = vi.fn().mockResolvedValue(undefined);
  await act(async () => root.render(<ReleaseChannelControl channels={["stable", "rolling"]} selected="stable" busy={false} change={change} refresh={refresh} />));
  await click("Release channelStable"); await click("Rolling");
  expect(container.textContent).toContain("Rolling saved. Release information could not be refreshed");
});

it("does not refresh after an unsuccessful save and exposes retry state", async () => {
  const change = vi.fn().mockResolvedValue(undefined); const refresh = vi.fn();
  await act(async () => root.render(<ReleaseChannelControl channels={["stable", "rolling"]} selected="stable" busy={false} change={change} refresh={refresh} />));
  await click("Release channelStable"); await click("Rolling");
  expect(refresh).not.toHaveBeenCalled(); expect(container.textContent).toContain("Channel change was not confirmed");
  expect(container.querySelector<HTMLButtonElement>(".choice-trigger")?.disabled).toBe(false);
});

it("disables choices while saving and ignores completion from an old library", async () => {
  let resolve!: (value: PortStatus) => void;
  const change = vi.fn(() => new Promise<PortStatus>(done => { resolve = done; })); const refresh = vi.fn();
  await act(async () => root.render(<ReleaseChannelControl key="library-1" channels={["stable", "rolling"]} selected="stable" busy={false} change={change} refresh={refresh} />));
  await click("Release channelStable"); await click("Rolling");
  expect(container.querySelector<HTMLButtonElement>(".choice-trigger")?.disabled).toBe(true);
  await act(async () => root.render(<ReleaseChannelControl key="library-2" channels={["stable", "rolling"]} selected="stable" busy={false} change={change} refresh={refresh} />));
  await act(async () => resolve(saved));
  expect(refresh).not.toHaveBeenCalled(); expect(container.textContent).not.toContain("Rolling selected");
});

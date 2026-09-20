// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desktopApi } from "../../api";
import type { BootstrapStatus } from "../../types";
import { useBootstrapState } from "./use-bootstrap-state";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const ready = (generation: number) => ({ ready: true, generation }) as BootstrapStatus;
let root: Root;
let state: ReturnType<typeof useBootstrapState>;

function Fixture({
  chooseFolder = async () => null,
}: {
  chooseFolder?: () => Promise<string | null>;
}) {
  state = useBootstrapState(chooseFolder);
  return null;
}

async function render(chooseFolder?: () => Promise<string | null>) {
  await act(async () => root.render(createElement(Fixture, { chooseFolder })));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.createElement("div"));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("bootstrap state", () => {
  it("publishes the initial bootstrap status", async () => {
    const pending = deferred<BootstrapStatus>();
    vi.spyOn(desktopApi, "bootstrapStatus").mockReturnValue(pending.promise);
    await render();
    expect(state.bootstrap).toBeUndefined();

    await act(async () => pending.resolve(ready(1)));

    expect(state.bootstrap).toEqual(ready(1));
    expect(state.bootstrapError).toBeUndefined();
  });

  it("normalizes an unstructured bootstrap failure", async () => {
    vi.spyOn(desktopApi, "bootstrapStatus").mockRejectedValue(new Error("offline"));
    await render();

    expect(state.bootstrap).toBeUndefined();
    expect(state.bootstrapError).toEqual({ code: "state", message: "offline", details: {} });
  });

  it("does not switch libraries when folder selection is cancelled", async () => {
    vi.spyOn(desktopApi, "bootstrapStatus").mockResolvedValue(ready(1));
    const setDefault = vi.spyOn(desktopApi, "setDefaultLibrary");
    const chooseFolder = vi.fn().mockResolvedValue(null);
    await render(chooseFolder);

    await act(async () => state.chooseLibrary("D:/current"));

    expect(chooseFolder).toHaveBeenCalledWith("D:/current");
    expect(setDefault).not.toHaveBeenCalled();
    expect(state.bootstrap).toEqual(ready(1));
  });

  it("publishes successful library switches and resets", async () => {
    vi.spyOn(desktopApi, "bootstrapStatus").mockRejectedValue(new Error("offline"));
    vi.spyOn(desktopApi, "setDefaultLibrary").mockResolvedValue(ready(2));
    vi.spyOn(desktopApi, "resetDefaultLibrary").mockResolvedValue(ready(3));
    const chooseFolder = vi.fn().mockResolvedValue("E:/library");
    await render(chooseFolder);
    expect(state.bootstrapError).toBeDefined();

    await act(async () => state.chooseLibrary());
    expect(desktopApi.setDefaultLibrary).toHaveBeenCalledWith("E:/library");
    expect(state.bootstrap).toEqual(ready(2));
    expect(state.bootstrapError).toBeUndefined();

    await act(async () => state.resetLibrary());
    expect(desktopApi.resetDefaultLibrary).toHaveBeenCalledOnce();
    expect(state.bootstrap).toEqual(ready(3));
  });
});

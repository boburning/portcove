import { useState } from "react";
import { cleanup, renderHook } from "vitest-browser-react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { controlledAct } from "../../test/controlled-react-act";

const environment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean | undefined;
};
afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

it("flushes controlled updates between renderer operations without leaking act mode", async () => {
  const errors = vi.spyOn(console, "error");
  const hook = await renderHook(() => useState(0));
  expect(environment.IS_REACT_ACT_ENVIRONMENT).toBe(false);
  await controlledAct(async () => {
    await Promise.resolve();
    hook.result.current[1](1);
  });
  expect(hook.result.current[0]).toBe(1);
  expect(environment.IS_REACT_ACT_ENVIRONMENT).toBe(false);
  await hook.rerender();
  expect(errors).not.toHaveBeenCalled();
});

it("retains a surrounding controlled batch through nested state updates", async () => {
  const hook = await renderHook(() => useState(0));
  await controlledAct(async () => {
    await controlledAct(() => hook.result.current[1](1));
    expect(environment.IS_REACT_ACT_ENVIRONMENT).toBe(true);
    hook.result.current[1](2);
  });
  expect(hook.result.current[0]).toBe(2);
  expect(environment.IS_REACT_ACT_ENVIRONMENT).toBe(false);
});

it("restores environment absence and preserves the original rejected callback", async () => {
  const hook = await renderHook(() => useState(0));
  delete environment.IS_REACT_ACT_ENVIRONMENT;
  const failure = new Error("controlled fixture rejection");
  await expect(
    controlledAct(() => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(Object.hasOwn(environment, "IS_REACT_ACT_ENVIRONMENT")).toBe(false);
  await controlledAct(() => hook.result.current[1](1));
  expect(hook.result.current[0]).toBe(1);
  expect(Object.hasOwn(environment, "IS_REACT_ACT_ENVIRONMENT")).toBe(false);
});

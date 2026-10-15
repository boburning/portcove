import { StrictMode } from "react";
import { renderHook, cleanup } from "vitest-browser-react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { desktopApi } from "../../api";
import type { ApplicationUpdatePreferences } from "../../types";
import { useApplicationUpdateChoice } from "./use-application-update";

const saved: ApplicationUpdatePreferences = {
  schema_version: 1,
  revision: 4,
  choice: { channel: "preview", mode: "notify-only", paused: false },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("application-update preference read owner", () => {
  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("coalesces concurrent reads and retains identity for unchanged revisions", async () => {
    const first = deferred<ApplicationUpdatePreferences>();
    const read = vi
      .spyOn(desktopApi, "applicationUpdatePreferences")
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue({ ...saved });
    const view = await renderHook(useApplicationUpdateChoice);
    let one!: Promise<ApplicationUpdatePreferences>;
    let two!: Promise<ApplicationUpdatePreferences>;
    await view.act(async () => {
      one = view.result.current.refresh();
      two = view.result.current.refresh();
    });
    expect(one).toBe(two);
    expect(read).toHaveBeenCalledTimes(1);
    await view.act(async () => first.resolve(saved));
    const identity = view.result.current.preferences;
    await view.act(async () => {
      await view.result.current.refresh();
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(view.result.current.preferences).toBe(identity);
    expect(view.result.current.loading).toBe(false);
  });

  it("does not replace an accepted mutation with an older in-flight read", async () => {
    const first = deferred<ApplicationUpdatePreferences>();
    vi.spyOn(desktopApi, "applicationUpdatePreferences").mockReturnValue(first.promise);
    const view = await renderHook(useApplicationUpdateChoice);
    const newer = { ...saved, revision: 5 };
    await view.act(async () => {
      view.result.current.accept(newer);
    });
    await view.act(async () => first.resolve(saved));
    expect(view.result.current.preferences).toBe(newer);
    expect(view.result.current.failure).toBeUndefined();
  });

  it("does not let an obsolete read failure hide a newer accepted mutation", async () => {
    const first = deferred<ApplicationUpdatePreferences>();
    vi.spyOn(desktopApi, "applicationUpdatePreferences").mockReturnValue(first.promise);
    const view = await renderHook(useApplicationUpdateChoice);
    await view.act(async () => {
      view.result.current.accept(saved);
    });
    await view.act(async () => first.reject(new Error("old read failed")));
    expect(view.result.current.preferences).toBe(saved);
    expect(view.result.current.failure).toBeUndefined();
    expect(view.result.current.loading).toBe(false);
  });

  it("exposes failed refreshes without authorizing from stale data and recovers", async () => {
    const failure = new Error("offline");
    vi.spyOn(desktopApi, "applicationUpdatePreferences")
      .mockResolvedValueOnce(saved)
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({ ...saved });
    const view = await renderHook(useApplicationUpdateChoice);
    await view.act(async () => {
      await expect(view.result.current.refresh()).rejects.toBe(failure);
    });
    expect(view.result.current.preferences).toBeUndefined();
    expect(view.result.current.failure).toBe(failure);
    await view.act(async () => {
      await view.result.current.refresh();
    });
    expect(view.result.current.preferences).toBe(saved);
    expect(view.result.current.failure).toBeUndefined();
  });

  it("ignores the disposed Strict Mode read while a new lifetime loads", async () => {
    const old = deferred<ApplicationUpdatePreferences>();
    const fresh = deferred<ApplicationUpdatePreferences>();
    const read = vi
      .spyOn(desktopApi, "applicationUpdatePreferences")
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(fresh.promise);
    const view = await renderHook(useApplicationUpdateChoice, { wrapper: StrictMode });
    expect(read).toHaveBeenCalledTimes(2);
    await view.act(async () => old.resolve({ ...saved, revision: 99 }));
    expect(view.result.current.preferences).toBeUndefined();
    expect(view.result.current.loading).toBe(true);
    await view.act(async () => fresh.resolve(saved));
    expect(view.result.current.preferences).toBe(saved);
  });

  it("does not publish a late result or acceptance after unmount", async () => {
    const read = deferred<ApplicationUpdatePreferences>();
    vi.spyOn(desktopApi, "applicationUpdatePreferences").mockReturnValue(read.promise);
    const view = await renderHook(useApplicationUpdateChoice);
    const unmounted = view.result.current;
    await view.unmount();
    await view.act(async () => {
      read.resolve(saved);
      unmounted.accept(saved);
    });
    expect(unmounted.preferences).toBeUndefined();
    expect(view.result.current).toBe(unmounted);
  });

  it.each([1, 4])("accepts a fresh externally recovered revision %s", async (revision) => {
    const recovered = { ...saved, revision, choice: null };
    vi.spyOn(desktopApi, "applicationUpdatePreferences")
      .mockResolvedValueOnce(saved)
      .mockResolvedValueOnce(recovered);
    const view = await renderHook(useApplicationUpdateChoice);
    await view.act(async () => {
      await view.result.current.refresh();
    });
    expect(view.result.current.preferences).toBe(recovered);
    expect(view.result.current.choiceRequired).toBe(true);
  });

  it("invalidates pre-recovery reads including their returned value", async () => {
    const old = deferred<ApplicationUpdatePreferences>();
    vi.spyOn(desktopApi, "applicationUpdatePreferences")
      .mockResolvedValueOnce(saved)
      .mockReturnValueOnce(old.promise);
    const view = await renderHook(useApplicationUpdateChoice);
    let pending!: Promise<ApplicationUpdatePreferences>;
    await view.act(async () => {
      pending = view.result.current.refresh();
    });
    const recovered = { ...saved, revision: 1, choice: null };
    await view.act(async () => {
      view.result.current.acceptRecovered(recovered);
    });
    await view.act(async () => old.resolve({ ...saved, revision: 5 }));
    expect(await pending).toBe(recovered);
    expect(view.result.current.preferences).toBe(recovered);
    expect(view.result.current.loading).toBe(false);
  });

  it("binds dismissal to identity when recovery reuses a revision", async () => {
    vi.spyOn(desktopApi, "applicationUpdatePreferences").mockResolvedValue({
      ...saved,
      choice: null,
    });
    const view = await renderHook(useApplicationUpdateChoice);
    await view.act(async () => view.result.current.dismiss());
    expect(view.result.current.choiceRequired).toBe(false);
    await view.act(async () => {
      view.result.current.accept({ ...saved, revision: 5 });
    });
    await view.act(async () => {
      view.result.current.acceptRecovered({ ...saved, choice: null });
    });
    expect(view.result.current.choiceRequired).toBe(true);
  });
});

// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  let root: Root;
  let host: HTMLDivElement;
  let state!: ReturnType<typeof useApplicationUpdateChoice>;
  function Fixture() {
    state = useApplicationUpdateChoice();
    return <span>{state.preferences?.revision}</span>;
  }
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("coalesces concurrent reads and retains identity for unchanged revisions", async () => {
    const first = deferred<ApplicationUpdatePreferences>();
    const read = vi
      .spyOn(desktopApi, "applicationUpdatePreferences")
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue({ ...saved });
    await act(async () => root.render(<Fixture />));
    let one!: Promise<ApplicationUpdatePreferences>;
    let two!: Promise<ApplicationUpdatePreferences>;
    await act(async () => {
      one = state.refresh();
      two = state.refresh();
    });
    expect(one).toBe(two);
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => first.resolve(saved));
    const identity = state.preferences;
    await act(async () => {
      await state.refresh();
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(state.preferences).toBe(identity);
    expect(state.loading).toBe(false);
  });

  it("does not replace an accepted mutation with an older in-flight read", async () => {
    const first = deferred<ApplicationUpdatePreferences>();
    vi.spyOn(desktopApi, "applicationUpdatePreferences").mockReturnValue(first.promise);
    await act(async () => root.render(<Fixture />));
    const newer = { ...saved, revision: 5 };
    await act(async () => {
      state.accept(newer);
    });
    await act(async () => first.resolve(saved));
    expect(state.preferences).toBe(newer);
    expect(state.failure).toBeUndefined();
  });

  it("does not let an obsolete read failure hide a newer accepted mutation", async () => {
    const first = deferred<ApplicationUpdatePreferences>();
    vi.spyOn(desktopApi, "applicationUpdatePreferences").mockReturnValue(first.promise);
    await act(async () => root.render(<Fixture />));
    await act(async () => {
      state.accept(saved);
    });
    await act(async () => first.reject(new Error("old read failed")));
    expect(state.preferences).toBe(saved);
    expect(state.failure).toBeUndefined();
    expect(state.loading).toBe(false);
  });

  it("exposes failed refreshes without authorizing from stale data and recovers", async () => {
    const failure = new Error("offline");
    vi.spyOn(desktopApi, "applicationUpdatePreferences")
      .mockResolvedValueOnce(saved)
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({ ...saved });
    await act(async () => root.render(<Fixture />));
    await act(async () => {
      await expect(state.refresh()).rejects.toBe(failure);
    });
    expect(state.preferences).toBeUndefined();
    expect(state.failure).toBe(failure);
    await act(async () => {
      await state.refresh();
    });
    expect(state.preferences).toBe(saved);
    expect(state.failure).toBeUndefined();
  });

  it("ignores the disposed Strict Mode read while a new lifetime loads", async () => {
    const old = deferred<ApplicationUpdatePreferences>();
    const fresh = deferred<ApplicationUpdatePreferences>();
    const read = vi
      .spyOn(desktopApi, "applicationUpdatePreferences")
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(fresh.promise);
    await act(async () =>
      root.render(
        <StrictMode>
          <Fixture />
        </StrictMode>,
      ),
    );
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => old.resolve({ ...saved, revision: 99 }));
    expect(state.preferences).toBeUndefined();
    expect(state.loading).toBe(true);
    await act(async () => fresh.resolve(saved));
    expect(state.preferences).toBe(saved);
  });

  it("does not publish a late result or acceptance after unmount", async () => {
    const read = deferred<ApplicationUpdatePreferences>();
    vi.spyOn(desktopApi, "applicationUpdatePreferences").mockReturnValue(read.promise);
    await act(async () => root.render(<Fixture />));
    const unmounted = state;
    await act(async () => root.render(null));
    await act(async () => {
      read.resolve(saved);
      unmounted.accept(saved);
    });
    expect(unmounted.preferences).toBeUndefined();
    expect(host.textContent).toBe("");
  });

  it.each([1, 4])("accepts a fresh externally recovered revision %s", async (revision) => {
    const recovered = { ...saved, revision, choice: null };
    vi.spyOn(desktopApi, "applicationUpdatePreferences")
      .mockResolvedValueOnce(saved)
      .mockResolvedValueOnce(recovered);
    await act(async () => root.render(<Fixture />));
    await act(async () => {
      await state.refresh();
    });
    expect(state.preferences).toBe(recovered);
    expect(state.choiceRequired).toBe(true);
  });

  it("invalidates pre-recovery reads including their returned value", async () => {
    const old = deferred<ApplicationUpdatePreferences>();
    vi.spyOn(desktopApi, "applicationUpdatePreferences")
      .mockResolvedValueOnce(saved)
      .mockReturnValueOnce(old.promise);
    await act(async () => root.render(<Fixture />));
    let pending!: Promise<ApplicationUpdatePreferences>;
    await act(async () => {
      pending = state.refresh();
    });
    const recovered = { ...saved, revision: 1, choice: null };
    await act(async () => {
      state.acceptRecovered(recovered);
    });
    await act(async () => old.resolve({ ...saved, revision: 5 }));
    expect(await pending).toBe(recovered);
    expect(state.preferences).toBe(recovered);
    expect(state.loading).toBe(false);
  });

  it("binds dismissal to identity when recovery reuses a revision", async () => {
    vi.spyOn(desktopApi, "applicationUpdatePreferences").mockResolvedValue({
      ...saved,
      choice: null,
    });
    await act(async () => root.render(<Fixture />));
    await act(async () => state.dismiss());
    expect(state.choiceRequired).toBe(false);
    await act(async () => {
      state.accept({ ...saved, revision: 5 });
    });
    await act(async () => {
      state.acceptRecovered({ ...saved, choice: null });
    });
    expect(state.choiceRequired).toBe(true);
  });
});

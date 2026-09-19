// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desktopApi } from "../../api";
import type { GithubAuthStatus } from "../../types";
import { useGithubAuth } from "./use-github-auth";

const anonymous: GithubAuthStatus = {
  authenticated: false,
  device_login_available: true,
  login: null,
  rate_limit: null,
  source: "anonymous",
};

const authenticated: GithubAuthStatus = {
  authenticated: true,
  device_login_available: true,
  login: "octocat",
  rate_limit: { limit: 5000, remaining: 4999, resets_at: 10 },
  source: "credential_store",
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

describe("GitHub authentication read owner", () => {
  let root: Root;
  let host: HTMLDivElement;
  let state!: ReturnType<typeof useGithubAuth>;
  let perform: Parameters<typeof useGithubAuth>[0];
  let setError: ReturnType<typeof vi.fn<(error?: string) => void>>;

  function Fixture() {
    state = useGithubAuth(perform, setError);
    return <span>{state.status?.login ?? "anonymous"}</span>;
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    root = createRoot(host);
    perform = async <T,>(_name: string, task: () => Promise<T>) => task();
    setError = vi.fn();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await act(async () => root.unmount());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps the newest status read when the initial read finishes late", async () => {
    const initial = deferred<GithubAuthStatus>();
    const refresh = deferred<GithubAuthStatus>();
    vi.spyOn(desktopApi, "githubAuthStatus")
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(refresh.promise);

    await act(async () => root.render(<Fixture />));
    await act(async () => {
      const pending = state.refresh();
      refresh.resolve(authenticated);
      await pending;
    });
    await act(async () => initial.resolve(anonymous));

    expect(state.status).toBe(authenticated);
    expect(host.textContent).toBe("octocat");
  });

  it("reports the current read failure and recovers through the same owner", async () => {
    const failure = new Error("offline");
    vi.spyOn(desktopApi, "githubAuthStatus")
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(authenticated);

    await act(async () => root.render(<Fixture />));
    expect(setError).toHaveBeenCalledExactlyOnceWith("offline");
    await act(async () => state.refresh());

    expect(state.status).toBe(authenticated);
  });

  it("does not report an obsolete read failure after a newer refresh succeeds", async () => {
    const initial = deferred<GithubAuthStatus>();
    vi.spyOn(desktopApi, "githubAuthStatus")
      .mockReturnValueOnce(initial.promise)
      .mockResolvedValueOnce(authenticated);

    await act(async () => root.render(<Fixture />));
    await act(async () => state.refresh());
    await act(async () => initial.reject(new Error("obsolete")));

    expect(state.status).toBe(authenticated);
    expect(setError).not.toHaveBeenCalled();
  });

  it("does not let an older read replace a completed credential mutation", async () => {
    const initial = deferred<GithubAuthStatus>();
    vi.spyOn(desktopApi, "githubAuthStatus").mockReturnValue(initial.promise);
    const save = vi.spyOn(desktopApi, "setGithubToken").mockResolvedValue(authenticated);

    await act(async () => root.render(<Fixture />));
    await act(async () => state.setToken("secret"));
    await act(async () => state.saveToken());
    await act(async () => initial.resolve(anonymous));

    expect(save).toHaveBeenCalledExactlyOnceWith("secret");
    expect(state.status).toBe(authenticated);
    expect(state.token).toBe("");
  });

  it("accepts completed device login and invalidates an older status read", async () => {
    vi.useFakeTimers();
    const initial = deferred<GithubAuthStatus>();
    vi.spyOn(desktopApi, "githubAuthStatus").mockReturnValue(initial.promise);
    vi.spyOn(desktopApi, "beginGithubDeviceLogin").mockResolvedValue({
      expires_at: 60,
      interval_seconds: 1,
      session_id: "session",
      user_code: "CODE",
      verification_uri: "https://github.com/login/device",
    });
    const poll = vi.spyOn(desktopApi, "pollGithubDeviceLogin").mockResolvedValue({
      state: "complete",
      status: authenticated,
    });

    await act(async () => root.render(<Fixture />));
    await act(async () => state.beginDeviceLogin());
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    await act(async () => initial.resolve(anonymous));

    expect(poll).toHaveBeenCalledExactlyOnceWith("session");
    expect(state.status).toBe(authenticated);
    expect(state.deviceLogin).toBeUndefined();
  });

  it("waits for an in-flight device poll before saving a newer token", async () => {
    vi.useFakeTimers();
    vi.spyOn(desktopApi, "githubAuthStatus").mockResolvedValue(anonymous);
    vi.spyOn(desktopApi, "beginGithubDeviceLogin").mockResolvedValue({
      expires_at: 60,
      interval_seconds: 1,
      session_id: "old-session",
      user_code: "OLD",
      verification_uri: "https://github.com/login/device",
    });
    const poll = deferred<Awaited<ReturnType<typeof desktopApi.pollGithubDeviceLogin>>>();
    vi.spyOn(desktopApi, "pollGithubDeviceLogin").mockReturnValue(poll.promise);
    const save = vi.spyOn(desktopApi, "setGithubToken").mockResolvedValue(authenticated);

    await act(async () => root.render(<Fixture />));
    await act(async () => state.beginDeviceLogin());
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    await act(async () => state.setToken("new-token"));
    let saving!: Promise<void>;
    await act(async () => {
      saving = state.saveToken();
      await Promise.resolve();
    });
    expect(save).not.toHaveBeenCalled();
    await act(async () => poll.resolve({ state: "complete", status: anonymous }));
    await act(async () => saving);

    expect(save).toHaveBeenCalledExactlyOnceWith("new-token");
    expect(state.status).toBe(authenticated);
    expect(state.deviceLogin).toBeUndefined();
  });

  it("waits for an in-flight device poll before starting a replacement session", async () => {
    vi.useFakeTimers();
    vi.spyOn(desktopApi, "githubAuthStatus").mockResolvedValue(anonymous);
    const begin = vi
      .spyOn(desktopApi, "beginGithubDeviceLogin")
      .mockResolvedValueOnce({
        expires_at: 60,
        interval_seconds: 1,
        session_id: "old-session",
        user_code: "OLD",
        verification_uri: "https://github.com/login/device",
      })
      .mockResolvedValueOnce({
        expires_at: 120,
        interval_seconds: 1,
        session_id: "new-session",
        user_code: "NEW",
        verification_uri: "https://github.com/login/device",
      });
    const poll = deferred<Awaited<ReturnType<typeof desktopApi.pollGithubDeviceLogin>>>();
    vi.spyOn(desktopApi, "pollGithubDeviceLogin").mockReturnValue(poll.promise);

    await act(async () => root.render(<Fixture />));
    await act(async () => state.beginDeviceLogin());
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    let replacing!: Promise<void>;
    await act(async () => {
      replacing = state.beginDeviceLogin();
      await Promise.resolve();
    });
    expect(begin).toHaveBeenCalledTimes(1);
    await act(async () => poll.resolve({ state: "pending", status: null }));
    await act(async () => replacing);

    expect(begin).toHaveBeenCalledTimes(2);
    expect(state.deviceLogin?.session_id).toBe("new-session");
  });

  it("runs credential mutations in request order", async () => {
    vi.spyOn(desktopApi, "githubAuthStatus").mockResolvedValue(anonymous);
    const saveResult = deferred<GithubAuthStatus>();
    vi.spyOn(desktopApi, "setGithubToken").mockReturnValue(saveResult.promise);
    const logout = vi.spyOn(desktopApi, "logoutGithub").mockResolvedValue(anonymous);

    await act(async () => root.render(<Fixture />));
    await act(async () => state.setToken("new-token"));
    let saving!: Promise<void>;
    let loggingOut!: Promise<void>;
    await act(async () => {
      saving = state.saveToken();
      loggingOut = state.logout();
      await Promise.resolve();
    });
    expect(logout).not.toHaveBeenCalled();
    await act(async () => saveResult.resolve(authenticated));
    await act(async () => Promise.all([saving, loggingOut]));

    expect(logout).toHaveBeenCalledOnce();
    expect(state.status).toBe(anonymous);
  });

  it("does not publish a late read or error after unmount", async () => {
    const initial = deferred<GithubAuthStatus>();
    vi.spyOn(desktopApi, "githubAuthStatus").mockReturnValue(initial.promise);

    await act(async () => root.render(<Fixture />));
    const unmounted = state;
    await act(async () => root.render(null));
    await act(async () => initial.resolve(authenticated));

    expect(unmounted.status).toBeUndefined();
    expect(setError).not.toHaveBeenCalled();
    expect(host.textContent).toBe("");
  });
});

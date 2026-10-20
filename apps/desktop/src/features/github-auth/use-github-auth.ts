import { useCallback, useEffect, useRef, useState } from "react";
import { desktopApi } from "../../api";
import { LatestRequestGeneration } from "../../shared/concurrency-state";
import type { GithubAuthStatus, GithubDeviceLogin } from "../../types";
import { errorText } from "../../view-model";
import type { Perform, ReportError } from "../operations/use-operation-state";
import { targetInvocationContext } from "../operations/invocation-state";

export function useGithubAuth(perform: Perform, setError: ReportError, libraryGeneration: number) {
  const accountContext = useCallback(
    (action: string) =>
      targetInvocationContext(
        action,
        { kind: "application", id: "github-account", label: "GitHub account" },
        libraryGeneration,
        "application",
      ),
    [libraryGeneration],
  );
  const [status, setStatus] = useState<GithubAuthStatus>();
  const [token, setToken] = useState("");
  const [deviceLogin, setDeviceLogin] = useState<GithubDeviceLogin>();
  const statusReads = useRef(new LatestRequestGeneration());
  const deviceSession = useRef(0);
  const activeDevicePoll = useRef<Promise<void>>(Promise.resolve());
  const authOperations = useRef<Promise<void>>(Promise.resolve());
  const mounted = useRef(false);
  const acceptStatus = useCallback((next: GithubAuthStatus | undefined) => {
    if (!mounted.current) return;
    statusReads.current.begin();
    setStatus(next);
  }, []);
  const refresh = useCallback(async () => {
    const request = statusReads.current.begin();
    try {
      const next = await desktopApi.githubAuthStatus();
      if (mounted.current && statusReads.current.isCurrent(request)) setStatus(next);
    } catch (value) {
      if (mounted.current && statusReads.current.isCurrent(request))
        setError(errorText(value), accountContext("Check account status"));
    }
  }, [accountContext, setError]);
  const retireDeviceLogin = useCallback(async () => {
    deviceSession.current += 1;
    setDeviceLogin(undefined);
    await activeDevicePoll.current;
  }, []);
  const runAuthOperation = useCallback(
    <T>(task: () => Promise<T>) => {
      const result = authOperations.current.then(async () => {
        await retireDeviceLogin();
        return task();
      });
      authOperations.current = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    [retireDeviceLogin],
  );
  useEffect(() => {
    const requests = statusReads.current;
    const request = requests.begin();
    mounted.current = true;
    void desktopApi
      .githubAuthStatus()
      .then((next) => {
        if (mounted.current && requests.isCurrent(request)) setStatus(next);
      })
      .catch((value: unknown) => {
        if (mounted.current && requests.isCurrent(request))
          setError(errorText(value), accountContext("Check account status"));
      });
    return () => {
      mounted.current = false;
      requests.begin();
    };
  }, [accountContext, setError]);
  useEffect(() => {
    if (!deviceLogin) return;
    const session = ++deviceSession.current;
    let cancelled = false;
    const delay = Math.max(1, deviceLogin.interval_seconds) * 1000;
    let timer = 0;
    const poll = () => {
      if (cancelled || deviceSession.current !== session) return;
      const request = (async () => {
        try {
          const result = await desktopApi.pollGithubDeviceLogin(deviceLogin.session_id);
          if (cancelled || deviceSession.current !== session) return;
          if (result.state === "complete") {
            acceptStatus(result.status ?? undefined);
            setDeviceLogin(undefined);
          } else {
            timer = window.setTimeout(poll, delay);
          }
        } catch (value) {
          if (!cancelled && deviceSession.current === session) {
            setError(errorText(value), accountContext("Sign in"));
            setDeviceLogin(undefined);
          }
        }
      })();
      activeDevicePoll.current = request;
      void request.then(() => {
        if (activeDevicePoll.current === request) activeDevicePoll.current = Promise.resolve();
      });
    };
    timer = window.setTimeout(poll, delay);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (deviceSession.current === session) deviceSession.current += 1;
    };
  }, [acceptStatus, accountContext, deviceLogin, setError]);
  const saveToken = useCallback(async () => {
    const result = await runAuthOperation(() =>
      perform("GitHub authentication", () => desktopApi.setGithubToken(token), {
        refresh: "none",
        invalidateDiagnostics: false,
        context: accountContext("Save access token"),
      }),
    );
    if (result) {
      acceptStatus(result);
      setToken("");
    }
  }, [acceptStatus, accountContext, perform, runAuthOperation, token]);
  const logout = useCallback(async () => {
    const result = await runAuthOperation(() =>
      perform("GitHub logout", desktopApi.logoutGithub, {
        refresh: "none",
        invalidateDiagnostics: false,
        context: accountContext("Sign out"),
      }),
    );
    if (result) acceptStatus(result);
  }, [acceptStatus, accountContext, perform, runAuthOperation]);
  const beginDeviceLogin = useCallback(async () => {
    const result = await runAuthOperation(() =>
      perform("GitHub login", desktopApi.beginGithubDeviceLogin, {
        refresh: "none",
        invalidateDiagnostics: false,
        context: accountContext("Sign in"),
      }),
    );
    if (result && mounted.current) setDeviceLogin(result);
  }, [accountContext, perform, runAuthOperation]);
  return {
    status,
    token,
    setToken,
    deviceLogin,
    saveToken,
    logout,
    beginDeviceLogin,
    refresh,
  };
}

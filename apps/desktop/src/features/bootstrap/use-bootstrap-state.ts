import { useCallback, useEffect, useRef, useState } from "react";
import { desktopApi } from "../../api";
import { pickLibraryFolder } from "../../file-picker";
import type { BootstrapStatus, DesktopError } from "../../types";
import { errorText, failurePresentation } from "../../view-model";

export type StartupFailure = Pick<DesktopError, "code" | "message" | "details"> &
  Partial<Pick<DesktopError, "presentation">>;

type ChooseLibraryFolder = (currentPath: string) => Promise<string | null>;

export function useBootstrapState(chooseLibraryFolder: ChooseLibraryFolder = pickLibraryFolder) {
  const [state, setState] = useState<{
    bootstrap?: BootstrapStatus;
    bootstrapError?: StartupFailure;
  }>({});
  const [recoveryPending, setRecoveryPending] = useState(false);
  const ownership = useRef<{
    owner?: object;
    revision: number;
    pending?: object;
  }>({ revision: 0 });
  const acceptBootstrap = useCallback((next: BootstrapStatus) => {
    setState((current) =>
      current.bootstrap && next.generation < current.bootstrap.generation
        ? current
        : { bootstrap: next },
    );
  }, []);
  useEffect(() => {
    const ownershipState = ownership.current;
    const lifecycle = {};
    ownershipState.owner = lifecycle;
    const read = ++ownershipState.revision;
    const current = () => ownershipState.owner === lifecycle && ownershipState.revision === read;
    desktopApi
      .bootstrapStatus()
      .then((next) => {
        if (current()) acceptBootstrap(next);
      })
      .catch((value) => {
        if (current())
          setState({
            bootstrapError: failurePresentation(value)
              ? (value as DesktopError)
              : { code: "state", message: errorText(value), details: {} },
          });
      });
    return () => {
      if (ownershipState.owner === lifecycle) {
        ownershipState.owner = undefined;
        ++ownershipState.revision;
        ownershipState.pending = undefined;
      }
    };
  }, [acceptBootstrap]);

  const selectLibrary = async (
    operation: (current: () => boolean) => Promise<BootstrapStatus | undefined>,
  ) => {
    const ownershipState = ownership.current;
    const lifecycle = ownershipState.owner;
    if (!lifecycle || ownershipState.pending) return;
    const selection = {};
    const intent = ++ownershipState.revision;
    ownershipState.pending = selection;
    setRecoveryPending(true);
    const current = () =>
      ownershipState.owner === lifecycle &&
      ownershipState.revision === intent &&
      ownershipState.pending === selection;
    try {
      const next = await operation(current);
      if (next && current()) acceptBootstrap(next);
    } catch (error) {
      if (current()) throw error;
    } finally {
      if (current()) {
        ownershipState.pending = undefined;
        setRecoveryPending(false);
      }
    }
  };

  const switchLibrary = (path: string) => selectLibrary(() => desktopApi.setDefaultLibrary(path));
  const chooseLibrary = (currentPath = "") =>
    selectLibrary(async (current) => {
      const path = await chooseLibraryFolder(currentPath);
      return path && current() ? desktopApi.setDefaultLibrary(path) : undefined;
    });
  const resetLibrary = () => selectLibrary(() => desktopApi.resetDefaultLibrary());
  return { ...state, recoveryPending, switchLibrary, chooseLibrary, resetLibrary };
}

import { useEffect, useState } from "react";
import { desktopApi } from "../../api";
import { pickLibraryFolder } from "../../file-picker";
import type { BootstrapStatus, DesktopError } from "../../types";
import { errorText, failurePresentation } from "../../view-model";

export type StartupFailure = Pick<DesktopError, "code" | "message" | "details"> &
  Partial<Pick<DesktopError, "presentation">>;

type ChooseLibraryFolder = (currentPath: string) => Promise<string | null>;

export function useBootstrapState(chooseLibraryFolder: ChooseLibraryFolder = pickLibraryFolder) {
  const [bootstrap, setBootstrap] = useState<BootstrapStatus>();
  const [bootstrapError, setBootstrapError] = useState<StartupFailure>();
  useEffect(() => {
    desktopApi
      .bootstrapStatus()
      .then(setBootstrap)
      .catch((value) => {
        setBootstrapError(
          failurePresentation(value)
            ? (value as DesktopError)
            : { code: "state", message: errorText(value), details: {} },
        );
      });
  }, []);
  const switchLibrary = async (path: string) => {
    const next = await desktopApi.setDefaultLibrary(path);
    setBootstrap(next);
    setBootstrapError(undefined);
  };
  const chooseLibrary = async (currentPath = "") => {
    const path = await chooseLibraryFolder(currentPath);
    if (path) await switchLibrary(path);
  };
  const resetLibrary = async () => {
    const next = await desktopApi.resetDefaultLibrary();
    setBootstrap(next);
    setBootstrapError(undefined);
  };
  return { bootstrap, bootstrapError, switchLibrary, chooseLibrary, resetLibrary };
}

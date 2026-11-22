import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import type { DesktopSupportBundleExport, LibraryMetadataFile } from "../../types";

type ExportResult<T> = {
  receipt?: T | undefined;
  phase: "idle" | "exporting" | "saved" | "unconfirmed" | "failed";
  error?: unknown;
};

function useExportResult<T>() {
  const [result, setResult] = useState<ExportResult<T>>({ phase: "idle" });
  const inFlight = useRef(false);

  async function run(exportFile: () => Promise<T | undefined>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setResult(({ receipt }) => ({ phase: "exporting", receipt }));
    try {
      const receipt = await exportFile();
      if (receipt === undefined) setResult(({ receipt }) => ({ phase: "unconfirmed", receipt }));
      else setResult({ phase: "saved", receipt });
    } catch (error) {
      setResult(({ receipt }) => ({ phase: "failed", receipt, error }));
    } finally {
      inFlight.current = false;
    }
  }

  return { result, run };
}

const SettingsExports = createContext<{
  libraryInformation: ReturnType<typeof useExportResult<LibraryMetadataFile>>;
  supportReport: ReturnType<typeof useExportResult<DesktopSupportBundleExport>>;
} | null>(null);

/** Owned by the library generation, so changing views cannot discard or replay an export. */
export function SettingsExportResultsProvider({ children }: { children: ReactNode }) {
  const libraryInformation = useExportResult<LibraryMetadataFile>();
  const supportReport = useExportResult<DesktopSupportBundleExport>();
  return (
    <SettingsExports.Provider value={{ libraryInformation, supportReport }}>
      {children}
    </SettingsExports.Provider>
  );
}

export function useLibraryInformationExport() {
  const workspace = useContext(SettingsExports);
  const local = useExportResult<LibraryMetadataFile>();
  return workspace?.libraryInformation ?? local;
}

export function useSupportReportExport() {
  const workspace = useContext(SettingsExports);
  // Bootstrap recovery can export diagnostics without a ready workspace.
  const local = useExportResult<DesktopSupportBundleExport>();
  return workspace?.supportReport ?? local;
}

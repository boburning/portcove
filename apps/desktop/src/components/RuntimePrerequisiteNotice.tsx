import { useEffect, useState } from "react";
import { desktopApi } from "../api";
import { useAppTranslation } from "../localization";
import type { PortStatus, RuntimePrerequisite, RuntimePrerequisiteReport } from "../types";
import { ExternalLink } from "./ExternalLink";

/** Microsoft's own architecture names, shown untranslated as on its download pages. */
const ARCHITECTURE_LABELS = { x86: "x86", x64: "x64", arm64: "ARM64" } as const;

/**
 * Names the Microsoft runtimes Core reports missing for the current installation,
 * with Microsoft's official download page. Core reads the game's program and
 * decides presence; installed and unknown runtimes are not shown, so the notice
 * never turns an unchecked runtime into a missing one.
 */
export function RuntimePrerequisiteNotice({
  portId,
  generation,
  status,
  load = desktopApi.runtimePrerequisites,
}: {
  portId: string;
  generation: number;
  status?: PortStatus | undefined;
  load?: (portId: string, generation: number) => Promise<RuntimePrerequisiteReport | null>;
}) {
  // The report describes one installation; keying by it keeps a stale answer for
  // another game, library generation or installation from being shown.
  const currentInstall = status?.active?.id ?? status?.external_runtime?.id;
  const requestKey = `${portId}:${generation}:${currentInstall ?? ""}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    report: RuntimePrerequisiteReport | null;
  } | null>(null);
  const { t } = useAppTranslation("launch");
  useEffect(() => {
    if (currentInstall === undefined) return;
    let current = true;
    load(portId, generation).then(
      (report) => {
        if (current) setLoaded({ key: requestKey, report });
      },
      () => {
        // The notice is supplementary; a failed read must not block the details page.
        if (current) setLoaded({ key: requestKey, report: null });
      },
    );
    return () => {
      current = false;
    };
  }, [portId, generation, currentInstall, requestKey, status, load]);
  const report = loaded?.key === requestKey ? loaded.report : null;
  const missing = report?.requirements.filter((requirement) => requirement.presence === "missing");
  if (currentInstall === undefined || !missing?.length) return null;
  const name = (requirement: RuntimePrerequisite) => {
    const framework = requirement.framework;
    const product = (() => {
      switch (requirement.runtime) {
        case "visual_cpp_2015_or_later":
          return t("runtimes.visualCpp2015OrLater");
        case "visual_cpp_2013":
          return t("runtimes.visualCpp2013");
        case "visual_cpp_2012":
          return t("runtimes.visualCpp2012");
        case "visual_cpp_2010":
          return t("runtimes.visualCpp2010");
        case "directx_june_2010":
          return t("runtimes.directxJune2010");
        case "dotnet": {
          const version = framework?.version ?? "";
          switch (framework?.name) {
            case "Microsoft.WindowsDesktop.App":
              return t("runtimes.dotnetDesktop", { version });
            case "Microsoft.AspNetCore.App":
              return t("runtimes.aspnetCore", { version });
            case "Microsoft.NETCore.App":
              return t("runtimes.dotnetRuntime", { version });
            default:
              return t("runtimes.dotnetFramework", { name: framework?.name ?? "", version });
          }
        }
      }
    })();
    return requirement.architecture
      ? t("runtimes.item", {
          name: product,
          architecture: ARCHITECTURE_LABELS[requirement.architecture],
        })
      : product;
  };
  return (
    <section
      role="status"
      aria-label={t("runtimes.label")}
      data-runtime-prerequisites="missing"
      className="grid gap-2 rounded-md border border-pc-border p-3"
    >
      <p>{t("runtimes.missing")}</p>
      <ul className="grid gap-1">
        {missing.map((requirement) => (
          <li
            key={`${requirement.runtime}:${requirement.architecture ?? ""}:${requirement.framework?.name ?? ""}`}
            className="flex flex-wrap items-baseline gap-x-2"
          >
            <span>{name(requirement)}</span>
            <ExternalLink href={requirement.download_page}>{t("runtimes.download")}</ExternalLink>
          </li>
        ))}
      </ul>
      <p className="text-sm text-pc-muted-foreground">{t("runtimes.nextAction")}</p>
    </section>
  );
}

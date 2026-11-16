import { useEffect, useState } from "react";
import { desktopApi } from "../api";
import { useAppTranslation } from "../localization";
import type { PortStatus, RuntimePrerequisite, RuntimePrerequisiteReport } from "../types";
import { ExternalLink } from "./ExternalLink";
import { Button } from "./ui/button";

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
  load?: (
    portId: string,
    installId: string,
    generation: number,
  ) => Promise<RuntimePrerequisiteReport | null>;
}) {
  const currentInstall = status?.active?.id ?? status?.external_runtime?.id;
  if (currentInstall === undefined) return null;
  return (
    <InstallationRuntimeNotice
      key={JSON.stringify([portId, generation, currentInstall])}
      portId={portId}
      generation={generation}
      installId={currentInstall}
      load={load}
    />
  );
}

function InstallationRuntimeNotice({
  portId,
  generation,
  installId,
  load,
}: {
  portId: string;
  generation: number;
  installId: string;
  load: typeof desktopApi.runtimePrerequisites;
}) {
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{
    attempt: number;
    report: RuntimePrerequisiteReport | null;
  } | null>(null);
  const { t } = useAppTranslation("launch");
  useEffect(() => {
    let current = true;
    load(portId, installId, generation).then(
      (report) => {
        if (current) setLoaded({ attempt, report });
      },
      () => {
        // The notice is supplementary; a failed read must not block the details page.
        if (current) setLoaded({ attempt, report: null });
      },
    );
    return () => {
      current = false;
    };
  }, [portId, generation, installId, attempt, load]);
  const report = loaded?.report;
  const missing = report?.requirements.filter((requirement) => requirement.presence === "missing");
  if (!missing?.length && attempt === 0) return null;
  const checking = attempt !== 0 && loaded?.attempt !== attempt;
  const allPresent =
    report?.host === "checked" &&
    report.inspection === "complete" &&
    report.requirements.length > 0 &&
    report.requirements.every((requirement) => requirement.presence === "present");
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
      data-runtime-prerequisites={missing?.length ? "missing" : "rechecked"}
      className="grid gap-2 rounded-md border border-pc-border p-3"
    >
      {missing?.length ? (
        <>
          <p>{t("runtimes.missing")}</p>
          <ul className="grid gap-1">
            {missing.map((requirement) => (
              <li
                key={`${requirement.runtime}:${requirement.architecture ?? ""}:${requirement.framework?.name ?? ""}`}
                className="flex flex-wrap items-baseline gap-x-2"
              >
                <span>{name(requirement)}</span>
                <ExternalLink href={requirement.download_page}>
                  {t("runtimes.download")}
                </ExternalLink>
              </li>
            ))}
          </ul>
          <p className="text-sm text-pc-muted-foreground">{t("runtimes.nextAction")}</p>
        </>
      ) : !checking ? (
        <p>{allPresent ? t("runtimes.present") : t("runtimes.unconfirmed")}</p>
      ) : null}
      <Button
        className="justify-self-start"
        variant="outline"
        disabled={checking}
        focusableWhenDisabled={checking}
        onClick={() => setAttempt(attempt + 1)}
      >
        {checking ? t("runtimes.checking") : t("runtimes.recheck")}
      </Button>
    </section>
  );
}

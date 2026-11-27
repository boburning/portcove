import { useState } from "react";
import { desktopApi } from "../api";
import { useAppTranslation } from "../localization";
import type { ProviderBrowsePage } from "../types";
import { Button } from "./ui/button";

export function ExternalProviderCatalog({
  port,
  generation,
  source,
  url,
  name,
}: {
  port: string;
  generation: number;
  source: string;
  url: string;
  name: string;
}) {
  const { t } = useAppTranslation("gameSettings");
  const [result, setResult] = useState<ProviderBrowsePage>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<"catalog" | "project">();

  async function read(page: number) {
    setBusy(true);
    setFailure(undefined);
    try {
      setResult(await desktopApi.browseExternalProviderMods(port, generation, source, url, page));
    } catch {
      setFailure("catalog");
    } finally {
      setBusy(false);
    }
  }

  async function open(projectId: string) {
    setFailure(undefined);
    try {
      await desktopApi.openProviderModProject(port, projectId, generation, undefined, {
        source,
        url,
      });
    } catch {
      setFailure("project");
    }
  }

  return (
    <div className="space-y-2" aria-busy={busy}>
      <Button variant="outline" disabled={busy} onClick={() => void read(result?.page.page ?? 1)}>
        {result ? t("mods.external.checkAgain") : t("mods.browse.open", { provider: name })}
      </Button>
      {busy && <p>{t("mods.external.loading")}</p>}
      <p role="status">
        {failure === "catalog"
          ? t("mods.external.unavailable")
          : failure === "project"
            ? t("mods.external.linkUnavailable")
            : result?.freshness === "stale"
              ? t("mods.external.cached")
              : result && result.page.projects.length === 0
                ? t("mods.external.empty")
                : ""}
      </p>
      {result && result.page.projects.length > 0 && (
        <ul>
          {result.page.projects.map((project) => (
            <li className="border-b py-2" key={project.project_id}>
              <Button variant="link" onClick={() => void open(project.project_id)}>
                {project.name}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {result && (
        <div className="flex gap-2">
          {result.page.page > 1 && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void read(result.page.page - 1)}
            >
              {t("mods.external.previous")}
            </Button>
          )}
          {result.page.page < result.last_page && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void read(result.page.page + 1)}
            >
              {t("mods.external.more")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

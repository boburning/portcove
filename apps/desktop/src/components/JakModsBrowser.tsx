import { useState } from "react";
import { desktopApi } from "../api";
import { useAppTranslation } from "../localization";
import type { JakModsCatalog } from "../types";
import { errorText, platformLabel } from "../view-model";
import { ExternalLink } from "./ExternalLink";
import { Button } from "./ui/button";

export function JakModsBrowser({
  portId,
  generation,
  setupUrl,
}: {
  portId: string;
  generation: number;
  setupUrl: string;
}) {
  const { t, i18n } = useAppTranslation("gameSettings");
  const [catalog, setCatalog] = useState<JakModsCatalog>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState("");
  const read = async () => {
    setLoading(true);
    setError(undefined);
    try {
      setCatalog(await desktopApi.jakModsCatalog(portId, generation));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setLoading(false);
    }
  };
  const projects = catalog?.projects.filter((project) =>
    project.name
      .toLocaleLowerCase(i18n.language)
      .includes(query.trim().toLocaleLowerCase(i18n.language)),
  );
  return (
    <section className="grid gap-3" aria-label={t("jakMods.browse")}>
      <p>{t("jakMods.ownership")}</p>
      <div>
        <Button disabled={loading} onClick={() => void read()}>
          {loading ? t("jakMods.loading") : catalog ? t("jakMods.refresh") : t("jakMods.browse")}
        </Button>
      </div>
      <ExternalLink
        href={setupUrl}
        openUrl={(url) => desktopApi.openJakModsResource(portId, generation, url)}
      >
        {t("jakMods.setup")}
      </ExternalLink>
      {error && <p role="alert">{error}</p>}
      {catalog && (
        <>
          {(catalog.freshness === "stale" || error) && (
            <p role="status">{t("mods.workspace.cached")}</p>
          )}
          {!catalog.complete && <p>{t("jakMods.partial")}</p>}

          <p>{t("jakMods.feed", { url: catalog.feed_url })}</p>
          <label>
            {t("jakMods.search")}
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
          {projects?.length === 0 && <p>{t("jakMods.empty")}</p>}
          <ul className="grid gap-3">
            {projects?.map((project) => {
              const url = project.external_url ?? project.website_url;
              return (
                <li key={project.id} className="grid gap-1">
                  {project.artwork_url && (
                    <img
                      src={project.artwork_url}
                      alt=""
                      width={120}
                      height={68}
                      loading="lazy"
                      referrerPolicy="no-referrer"
                    />
                  )}
                  <strong>{project.name}</strong>
                  {project.summary && <p>{project.summary}</p>}
                  {project.build_status === "unknown" && <p>{t("jakMods.unknown")}</p>}
                  {project.build_status === "unavailable" && <p>{t("jakMods.unavailable")}</p>}
                  {project.kind === "external" && <p>{t("jakMods.external")}</p>}
                  {url && (
                    <ExternalLink
                      href={url}
                      openUrl={(target) =>
                        desktopApi.openJakModsResource(portId, generation, target, project.id)
                      }
                    >
                      {t("jakMods.source")}
                    </ExternalLink>
                  )}
                  {project.releases.length > 0 && (
                    <details>
                      <summary>{t("jakMods.builds")}</summary>
                      <ul>
                        {project.releases.map((release) => (
                          <li key={release.version}>
                            {release.version}
                            {release.published_at != null && (
                              <>
                                {" "}
                                ·{" "}
                                {new Date(release.published_at * 1000).toLocaleDateString(
                                  i18n.language,
                                )}
                              </>
                            )}
                            <ul>
                              {release.builds.map((build) => (
                                <li key={build.platform}>
                                  {platformLabel(build.platform)}
                                  {build.downloads != null && (
                                    <> · {t("jakMods.downloads", { value: build.downloads })}</>
                                  )}
                                </li>
                              ))}
                            </ul>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

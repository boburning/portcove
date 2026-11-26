import { useEffect, useState } from "react";
import { desktopApi } from "../api";
import { useAppTranslation } from "../localization";
import type { ModSetupsView } from "../types";
import { UpstreamModNotices } from "./UpstreamModNotices";
import { ExternalLink } from "./ExternalLink";

type Portals = NonNullable<ModSetupsView["external_mod_portals"]>;

export function useExternalModPortals(port: string, generation: number) {
  const key = JSON.stringify([port, generation]);
  const [read, setRead] = useState<{ key: string; portals: Portals }>();
  useEffect(() => {
    const readLifetime = new AbortController();
    void desktopApi.modSetups(port, generation, true).then(
      (view) => {
        if (!readLifetime.signal.aborted)
          setRead({ key, portals: view.external_mod_portals ?? [] });
      },
      () => {
        if (!readLifetime.signal.aborted) setRead(undefined);
      },
    );
    return () => {
      readLifetime.abort();
    };
  }, [key, port, generation]);
  return read?.key === key ? read.portals : [];
}

export function ExternalModPortals({
  portals,
  port,
  generation,
}: {
  portals: Portals;
  port: string;
  generation: number;
}) {
  const { t } = useAppTranslation("gameSettings");
  if (portals.length === 0) return null;
  const label = (portal: Portals[number]) =>
    ({
      nexus_mods: t("mods.external.nexus"),
      mod_io: t("mods.external.modIo"),
      mod_db: t("mods.external.modDb"),
      quaddicted: t("mods.external.quaddicted"),
      community_site: t("mods.external.site", { name: portal.name }),
    })[portal.site];
  return (
    <section aria-label={t("mods.external.heading")}>
      <p>{t("mods.external.owner")}</p>
      <ul>
        {portals.map((portal) => (
          <li key={portal.source}>
            <ExternalLink
              href={portal.url}
              openUrl={(href) =>
                desktopApi.openUpstreamModNotice(port, generation, portal.source, href)
              }
            >
              {label(portal)}
            </ExternalLink>
            <p>{portal.instructions}</p>
            {portal.browse_available && portal.browser && (
              <UpstreamModNotices
                key={JSON.stringify([port, generation, portal.source])}
                browser={portal.browser}
                source={portal.source}
                name={portal.name}
                port={port}
                generation={generation}
              />
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

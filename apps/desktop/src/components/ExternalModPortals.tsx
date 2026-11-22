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
  const actions = {
    "nexus-daggerfall-unity": [t("mods.external.nexus"), t("mods.external.daggerfallSetup")],
    "coop-dx": [t("mods.external.coopDx"), t("mods.external.coopSetup")],
    "mod-io-open-xcom": [t("mods.external.modIo"), t("mods.external.openXcomSetup")],
    "mod-db-arcane-dimensions": [t("mods.external.modDb"), t("mods.external.quakeSetup")],
    "mod-db-open-xcom": [t("mods.external.modDb"), t("mods.external.openXcomSetup")],
    quaddicted: [t("mods.external.quaddicted"), t("mods.external.quakeSetup")],
  } satisfies Record<Portals[number]["source"], [string, string]>;
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
              {actions[portal.source][0]}
            </ExternalLink>
            <p>{actions[portal.source][1]}</p>
            {portal.browse_available &&
              (portal.source === "quaddicted" || portal.source === "mod-db-arcane-dimensions") && (
                <UpstreamModNotices
                  key={JSON.stringify([port, generation, portal.source])}
                  source={portal.source}
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

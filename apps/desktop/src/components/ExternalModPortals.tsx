import { useEffect, useId, useState } from "react";
import { desktopApi } from "../api";
import { useAppTranslation } from "../localization";
import type { ModSetupsView } from "../types";
import { UpstreamModNotices } from "./UpstreamModNotices";
import { ExternalLink } from "./ExternalLink";

type Portals = NonNullable<ModSetupsView["external_mod_portals"]>;
type PortalView = Pick<ModSetupsView, "external_mod_portals" | "mod_portal_preferences">;
type Preferences = NonNullable<PortalView["mod_portal_preferences"]>;
type Choices = Preferences["preferences"]["choices"];

export function useExternalModPortals(
  port: string,
  generation: number,
  listingPortals: unknown,
  definitionSources: unknown,
) {
  const key = JSON.stringify([port, generation]);
  const [read, setRead] = useState<{ key: string; view: PortalView }>();
  useEffect(() => {
    const readLifetime = new AbortController();
    void desktopApi.modSetups(port, generation, true).then(
      (view) => {
        if (!readLifetime.signal.aborted) setRead({ key, view });
      },
      () => {
        if (!readLifetime.signal.aborted) setRead(undefined);
      },
    );
    return () => {
      readLifetime.abort();
    };
  }, [key, port, generation, listingPortals, definitionSources]);
  return read?.key === key ? read.view : undefined;
}

export function ExternalModPortals({
  view,
  port,
  generation,
}: {
  view: PortalView | undefined;
  port: string;
  generation: number;
}) {
  const { t } = useAppTranslation("gameSettings");
  const scope = JSON.stringify([port, generation]);
  const [saved, setSaved] = useState<{ scope: string; initial: PortalView; current: PortalView }>();
  const parentRevision = view?.mod_portal_preferences?.preferences.revision ?? -1;
  const localRevision = saved?.current.mod_portal_preferences?.preferences.revision ?? -1;
  const current =
    saved?.scope === scope && view && (localRevision > parentRevision || saved.initial === view)
      ? saved.current
      : view;
  const portals = current?.external_mod_portals ?? [];
  const preferences = current?.mod_portal_preferences;
  if (portals.length === 0 && !preferences) return null;
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
      {portals.length > 0 && <p>{t("mods.external.owner")}</p>}
      {portals.length > 0 && (
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
      )}
      {view && preferences && (
        <ModPortalEditor
          key={scope}
          preferences={preferences}
          refresh={async () => {
            const current = await desktopApi.modSetups(port, generation, true);
            setSaved({ scope, initial: view, current });
          }}
          save={async (choices) => {
            const next = await desktopApi.setModPortalPreferences(
              port,
              generation,
              preferences.preferences.revision,
              choices,
            );
            setSaved({ scope, initial: view, current: next });
          }}
        />
      )}
    </section>
  );
}

function ModPortalEditor({
  preferences,
  refresh,
  save,
}: {
  preferences: Preferences;
  refresh: () => Promise<void>;
  save: (choices: Choices) => Promise<void>;
}) {
  const { t } = useAppTranslation("gameSettings");
  const field = useId();
  const [draft, setDraft] = useState<{
    revision: number;
    name: string;
    url: string;
    hidden: string[];
  }>();
  const [status, setStatus] = useState<"saving" | "saved" | "failed">();
  const { revision, choices } = preferences.preferences;
  const current =
    draft?.revision === revision
      ? draft
      : {
          revision,
          name: choices.local_page?.name ?? "",
          url: choices.local_page?.url ?? "",
          hidden: choices.hidden_sources,
        };
  const apply = async (selection: Choices) => {
    setStatus("saving");
    try {
      await save(selection);
      setDraft(undefined);
      setStatus("saved");
    } catch {
      setStatus("failed");
    }
  };
  return (
    <details className="mt-3">
      <summary>{t("mods.external.edit")}</summary>
      <form
        className="mt-2 flex flex-col items-start gap-2"
        aria-label={t("mods.external.edit")}
        onSubmit={(event) => {
          event.preventDefault();
          void apply({
            local_page: current.url.trim()
              ? { name: current.name.trim(), url: current.url.trim() }
              : null,
            hidden_sources: current.hidden,
          });
        }}
      >
        <label htmlFor={`${field}-name`}>{t("mods.external.websiteName")}</label>
        <input
          id={`${field}-name`}
          name="name"
          value={current.name}
          maxLength={80}
          required={Boolean(current.url.trim())}
          disabled={status === "saving"}
          onChange={(event) => setDraft({ ...current, name: event.currentTarget.value })}
        />
        <label htmlFor={`${field}-url`}>{t("mods.external.websiteUrl")}</label>
        <input
          id={`${field}-url`}
          name="url"
          type="url"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={256}
          value={current.url}
          required={Boolean(current.name.trim())}
          disabled={status === "saving"}
          onChange={(event) => setDraft({ ...current, url: event.currentTarget.value })}
        />
        {preferences.automatic_sources.length > 0 && (
          <fieldset>
            <legend>{t("mods.external.hideSources")}</legend>
            {preferences.automatic_sources.map((source, index) => (
              <div key={source.source}>
                <input
                  id={`${field}-source-${index}`}
                  name="hidden"
                  type="checkbox"
                  value={source.source}
                  checked={current.hidden.includes(source.source)}
                  disabled={status === "saving"}
                  onChange={(event) => {
                    const hidden = event.currentTarget.checked
                      ? [...current.hidden, source.source]
                      : current.hidden.filter((known) => known !== source.source);
                    setDraft({ ...current, hidden });
                  }}
                />
                <label htmlFor={`${field}-source-${index}`}>{source.name}</label>
              </div>
            ))}
          </fieldset>
        )}
        <div className="flex flex-wrap gap-2">
          <button type="submit" disabled={status === "saving"}>
            {t("mods.external.save")}
          </button>
          <button
            type="button"
            disabled={status === "saving"}
            onClick={() =>
              void apply({
                local_page: null,
                hidden_sources: [],
              })
            }
          >
            {t("mods.external.automatic")}
          </button>
          {status === "failed" && (
            <button
              type="button"
              onClick={() => {
                setStatus("saving");
                void refresh().then(
                  () => {
                    setDraft(undefined);
                    setStatus(undefined);
                  },
                  () => setStatus("failed"),
                );
              }}
            >
              {t("mods.external.checkAgain")}
            </button>
          )}
        </div>
        <p role="status">
          {status === "saved" && t("mods.external.saved")}
          {status === "failed" && t("mods.external.saveFailed")}
        </p>
      </form>
    </details>
  );
}

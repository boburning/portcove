import { useRef, useState } from "react";
import { desktopApi } from "../api";
import { useAppTranslation } from "../localization";
import type { ModDbFileNotices, ModSetupsView, QuaddictedCatalog } from "../types";
import { Button } from "./ui/button";

type ExternalModBrowser = NonNullable<
  NonNullable<ModSetupsView["external_mod_portals"]>[number]["browser"]
>;

type Result =
  | { browser: "quaddicted"; observation: QuaddictedCatalog }
  | { browser: "mod_db_feed"; observation: ModDbFileNotices };

export function UpstreamModNotices({
  browser,
  source,
  name,
  port,
  generation,
}: {
  browser: ExternalModBrowser;
  /** The declared source ID Core rechecks before opening a page. */
  source: string;
  name: string;
  port: string;
  generation: number;
}) {
  const { t } = useAppTranslation("gameSettings");
  const [result, setResult] = useState<Result>();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [linkFailed, setLinkFailed] = useState(false);
  const request = useRef(0);

  async function read(page: number, term: string) {
    const id = ++request.current;
    setBusy(true);
    setFailed(false);
    setLinkFailed(false);
    setResult(undefined);
    setQuery(term);
    try {
      const next: Result =
        browser === "quaddicted"
          ? {
              browser,
              observation: await desktopApi.quaddictedCatalog(
                port,
                generation,
                page,
                term || undefined,
              ),
            }
          : { browser, observation: await desktopApi.modDbFileNotices(port, generation) };
      if (id === request.current) setResult(next);
    } catch {
      if (id === request.current) setFailed(true);
    } finally {
      if (id === request.current) setBusy(false);
    }
  }

  async function open(url: string) {
    setLinkFailed(false);
    try {
      await desktopApi.openUpstreamModNotice(port, generation, source, url);
    } catch {
      setLinkFailed(true);
    }
  }

  const stale = result?.observation.freshness === "stale";
  const hasEntries =
    result &&
    (result.browser === "quaddicted"
      ? result.observation.value.entries.length > 0
      : result.observation.value.notices.length > 0);
  const rowsIncomplete =
    result?.browser === "quaddicted" && result.observation.value.unreadable_rows > 0;
  const observation = result?.observation;
  const currentPage = result?.browser === "quaddicted" ? result.observation.value.page : 0;
  return (
    <div className="space-y-2">
      {browser === "quaddicted" ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void read(0, search.trim());
          }}
        >
          <label className="flex flex-col">
            {t("mods.external.searchFilename")}
            <input
              className="rounded-md border px-2 py-1"
              value={search}
              minLength={2}
              maxLength={64}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <Button type="submit" variant="outline" disabled={busy}>
            {search.trim() ? t("mods.external.search") : t("mods.external.latest")}
          </Button>
        </form>
      ) : (
        <Button variant="outline" disabled={busy} onClick={() => void read(0, "")}>
          {t("mods.external.notices", { name })}
        </Button>
      )}
      {busy && <p role="status">{t("mods.external.loading")}</p>}
      {failed && <p role="status">{t("mods.external.unavailable")}</p>}
      {linkFailed && <p role="alert">{t("mods.external.linkUnavailable")}</p>}
      {observation && (
        <p>
          {observation.value.attribution} ·{" "}
          {t("mods.external.checked", {
            date: new Date(observation.observed_at * 1000).toLocaleString(),
          })}
        </p>
      )}
      {stale && <p role="status">{t("mods.external.cached")}</p>}
      {rowsIncomplete && <p role="status">{t("mods.external.incomplete")}</p>}
      {result && !stale && !hasEntries && !rowsIncomplete && <p>{t("mods.external.empty")}</p>}
      {result?.browser === "quaddicted" && (
        <>
          <ul>
            {result.observation.value.entries.map((row) => (
              <li key={row.claimed_sha256} className="border-b py-2">
                <p className="font-medium">{row.title}</p>
                <p>
                  {row.engine_compatibility === "declares_another_required_engine"
                    ? t("mods.external.otherEngine")
                    : t("mods.external.unverifiedEngine")}
                </p>
                {row.engine_requirements.length > 0 && <p>{row.engine_requirements.join(", ")}</p>}
                {row.release_date && <p>{row.release_date}</p>}
                <Button variant="link" onClick={() => void open(row.page_url)}>
                  {t("mods.external.quaddicted")}
                </Button>
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            {currentPage > 0 && (
              <Button variant="outline" onClick={() => void read(currentPage - 1, query)}>
                {t("mods.external.previous")}
              </Button>
            )}
            {result.observation.value.may_have_more && (
              <Button variant="outline" onClick={() => void read(currentPage + 1, query)}>
                {t("mods.external.more")}
              </Button>
            )}
          </div>
        </>
      )}
      {result?.browser === "mod_db_feed" && (
        <ul>
          {result.observation.value.notices.map((row) => (
            <li key={row.source_id} className="border-b py-2">
              <p className="font-medium">{row.title}</p>
              {row.published_at && <p>{row.published_at.slice(0, 10)}</p>}
              <Button variant="link" onClick={() => void open(row.page_url)}>
                {t("mods.external.modDb")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

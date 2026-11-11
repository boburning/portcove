import type { TFunction } from "i18next";
import { Trans } from "react-i18next";
import { useAppTranslation } from "../localization";
import type { BackupInventory, PortStatus } from "../types";
import type { BackupReadState } from "../features/backups/use-port-backups";

type Protection = NonNullable<BackupInventory["protection"]>;
type Installation = Protection["installations"][number];

function pathLabel(t: TFunction<"backups">, state: Protection["managed_data"]["state"]) {
  switch (state) {
    case "present":
      return t("protection.pathPresent");
    case "missing":
      return t("protection.pathMissing");
    case "unsafe":
      return t("protection.pathUnsafe");
    case "unreadable":
      return t("protection.pathUnreadable");
  }
}

function collectionLabel(t: TFunction<"backups">, collection: Installation["collection"]) {
  switch (collection) {
    case "selected_for_collection":
      return t("protection.collectionSelected");
    case "direct_to_managed_data":
      return t("protection.collectionDirect");
    case "not_initialized":
      return t("protection.collectionNotInitialized");
    case "inactive":
      return t("protection.collectionInactive");
    case "external_not_collected":
      return t("protection.collectionExternal");
    case "unavailable":
      return t("protection.collectionUnavailable");
  }
}

function installHeading(t: TFunction<"backups">, role: Installation["role"], version: string) {
  switch (role) {
    case "active":
      return t("protection.headingActive", { version });
    case "previous":
      return t("protection.headingPrevious", { version });
    case "staged":
      return t("protection.headingStaged", { version });
    case "external":
      return t("protection.headingExternal", { version });
  }
}

/** Presentation only. Existing Core assessments and reviewed actions own eligibility. */
export function ProtectionSummary({
  portId,
  status,
  protection,
  readState,
  inventoryState,
  problems = [],
}: {
  portId: string;
  status?: PortStatus | undefined;
  protection?: Protection | null | undefined;
  readState?: BackupReadState | undefined;
  inventoryState?: BackupInventory["state"] | undefined;
  problems?: BackupInventory["problems"] | undefined;
}) {
  const { t } = useAppTranslation("backups");
  const matches =
    protection?.port_id === portId &&
    status?.port_id === portId &&
    (status.active?.id ?? null) ===
      (protection.installations.find((install) => install.role === "active")?.install_id ?? null) &&
    (status.previous?.id ?? null) ===
      (protection.installations.find((install) => install.role === "previous")?.install_id ??
        null) &&
    (status.staged?.id ?? null) ===
      (protection.installations.find((install) => install.role === "staged")?.install_id ?? null) &&
    (status.external_runtime?.id ?? null) ===
      (protection.installations.find((install) => install.role === "external")?.install_id ?? null);
  const complete = inventoryState === "healthy" && problems.length === 0;
  const current = matches && readState?.status === "current" && readState.hasInventory;
  return (
    <section
      aria-label={t("protection.title")}
      className="grid min-w-0 gap-3 text-sm wrap-anywhere"
    >
      <h3 className="m-0 text-base font-semibold">{t("protection.title")}</h3>
      {!current && (
        <p role="status">
          {readState?.status === "failed"
            ? t("protection.loadFailed")
            : readState?.status === "pending"
              ? t("protection.checking")
              : readState?.status === "current" && readState.hasInventory
                ? // The list was read; only this installation's protection details are missing.
                  t("protection.detailsMissing")
                : t("protection.unavailable")}
        </p>
      )}
      {matches && protection && (
        <>
          <p>
            {current ? t("protection.latestInformation") : t("protection.lastLoadedInformation")}
          </p>
          {protection.problem && (
            <div role="status">
              <p>{t("protection.installationProblem")}</p>
              <details>
                <summary data-focusable>{t("protection.installationCheckDetails")}</summary>
                <p>{protection.problem}</p>
              </details>
            </div>
          )}
          {!protection.installations.length && !protection.problem && (
            <p>{t("protection.noInstallation")}</p>
          )}
          {!complete && <p role="status">{t("protection.unconfirmedLatest")}</p>}
          {protection.latest_completed_backup ? (
            <div>
              <p>
                {/* Dates follow the system's regional format, separate from message language. */}
                {current && complete
                  ? t("protection.latestBackup", {
                      time: new Date(
                        protection.latest_completed_backup.created_at * 1000,
                      ).toLocaleString(),
                      count: protection.latest_completed_backup.file_count,
                    })
                  : t("protection.lastKnownBackup", {
                      time: new Date(
                        protection.latest_completed_backup.created_at * 1000,
                      ).toLocaleString(),
                      count: protection.latest_completed_backup.file_count,
                    })}
              </p>
              <details>
                <summary data-focusable>{t("protection.backupIdentifier")}</summary>
                <code>{protection.latest_completed_backup.id}</code>
              </details>
            </div>
          ) : (
            <p>
              {!complete
                ? t("protection.historyIncomplete")
                : current
                  ? t("protection.noCompletedBackup")
                  : t("protection.noCompletedBackupLastLoaded")}
            </p>
          )}
          {protection.installations.map((install) => (
            <div
              className="grid gap-2 rounded-pc-md border border-pc-border p-3"
              key={install.install_id}
            >
              <h4 className="m-0 font-semibold">
                {installHeading(t, install.role, install.version)}
              </h4>
              <p>
                {install.update_owner === "portcove"
                  ? t("protection.updatesPortcove")
                  : t("protection.updatesExternal")}
              </p>
              <p>{collectionLabel(t, install.collection)}</p>
              {!install.retained && install.role !== "external" && (
                <p>{t("protection.rulesUnavailableVersion")}</p>
              )}
              {install.problem && (
                <details>
                  <summary data-focusable>{t("protection.backupCheckDetails")}</summary>
                  <p>{install.problem}</p>
                </details>
              )}
              {install.collection_root && (
                <p>
                  <Trans
                    t={t}
                    i18nKey="protection.foundAt"
                    values={{ path: install.collection_root }}
                    components={{ code: <code dir="ltr" /> }}
                  />
                </p>
              )}
              {!!install.collection_candidates.length && (
                <ul className="list-disc ps-5">
                  {install.collection_candidates.map((entry) => (
                    <li key={entry.path}>
                      <Trans
                        t={t}
                        i18nKey="protection.candidate"
                        values={{ path: entry.path, state: pathLabel(t, entry.state) }}
                        components={{ code: <code dir="ltr" /> }}
                      />
                    </li>
                  ))}
                </ul>
              )}
              <p>{t("protection.foundNotBackedUp")}</p>
              <Declaration title={t("protection.rulesInstallation")} value={install.retained} />
              <Declaration title={t("protection.filesConsidered")} value={install.effective} />
              {install.exclusions.map((text) => (
                <p key={text}>{text}</p>
              ))}
            </div>
          ))}
          <p>
            <Trans
              t={t}
              i18nKey="protection.savedFolder"
              values={{
                path: protection.managed_data.path,
                state: pathLabel(t, protection.managed_data.state),
              }}
              components={{ code: <code dir="ltr" /> }}
            />
          </p>
          <Declaration title={t("protection.rulesCatalog")} value={protection.catalog} />
          {protection.exclusions.map((text) => (
            <p key={text}>{text}</p>
          ))}
        </>
      )}
    </section>
  );
}

function Declaration({ title, value }: { title: string; value: Installation["retained"] }) {
  const { t } = useAppTranslation("backups");
  return (
    <details>
      <summary data-focusable className="cursor-pointer">
        {title}
      </summary>
      {value ? (
        <>
          <p>
            <Trans
              t={t}
              i18nKey="protection.definition"
              values={{ sha256: value.definition_sha256 }}
              components={{ code: <code /> }}
            />
          </p>
          <p>
            {value.saves_and_settings === "portcove-managed"
              ? t("protection.rulesPortcove")
              : value.saves_and_settings === "external-user-owned"
                ? t("protection.rulesExternal")
                : t("protection.rulesUnknown")}
          </p>
          {value.persistent_paths.length || value.persistent_file_patterns.length ? (
            <ul className="list-disc ps-5">
              {value.persistent_paths.map((path) => (
                <li key={path}>
                  <code>{path}</code>
                </li>
              ))}
              {value.persistent_file_patterns.map((pattern) => (
                <li key={`${pattern.prefix}:${pattern.suffix}`}>
                  <code>
                    {pattern.prefix}*{pattern.suffix}
                  </code>
                </li>
              ))}
            </ul>
          ) : (
            <p>{t("protection.noListedFiles")}</p>
          )}
        </>
      ) : (
        <p>{t("protection.rulesUnavailable")}</p>
      )}
    </details>
  );
}

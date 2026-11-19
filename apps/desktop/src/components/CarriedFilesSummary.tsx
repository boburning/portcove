import type { PortStatus } from "../types";
import { useAppTranslation } from "../localization";
import { formatBytes } from "../view-model";
import { CurrentStateSummary, MetadataGrid } from "./ui/patterns";

/** Core owns the recorded result. This surface offers no file or version mutation. */
export function CarriedFilesSummary({ record }: { record: PortStatus["carried_files"] }) {
  const { t } = useAppTranslation("detail");
  if (!record) return null;
  const outcome = record.outcome;
  const sizeLabel = (bytes: number) =>
    Number.isSafeInteger(bytes) && bytes >= 0 ? formatBytes(bytes) : t("carriedFiles.sizeUnknown");
  const groups = [
    { key: "carried", label: t("carriedFiles.copied"), paths: outcome.carried },
    { key: "removed", label: t("carriedFiles.removed"), paths: outcome.removed },
    { key: "kept_separately", label: t("carriedFiles.separate"), paths: outcome.kept_separately },
    {
      key: "source_unreadable",
      label: t("carriedFiles.unreadable"),
      paths: outcome.source_unreadable,
    },
    {
      key: "new_version_ships_file",
      label: t("carriedFiles.shipped"),
      paths: outcome.new_version_ships_file,
    },
  ] as const;
  const populated = groups.filter(
    (group) => group.paths.length > 0 || (outcome.counts?.[group.key] ?? 0) > 0,
  );
  if (!populated.length && !outcome.insufficient_space && !outcome.source_modified) return null;
  const details = (
    <details>
      <summary data-focusable>{t("carriedFiles.details")}</summary>
      <div className="grid min-w-0 gap-4 pt-3">
        <MetadataGrid>
          {outcome.not_carried_count != null && (
            <div>
              <dt>{t("carriedFiles.skippedCount")}</dt>
              <dd>
                {Number.isSafeInteger(outcome.not_carried_count)
                  ? t("carriedFiles.count", { value: outcome.not_carried_count })
                  : t("carriedFiles.countUnknown")}
              </dd>
            </div>
          )}
          <div>
            <dt>{t("carriedFiles.fromVersion")}</dt>
            <dd>
              {record.from_version != null ? (
                <bdi dir="ltr">{record.from_version}</bdi>
              ) : (
                t("carriedFiles.noLongerRecorded")
              )}
            </dd>
          </div>
          <div>
            <dt>{t("carriedFiles.toVersion")}</dt>
            <dd dir="ltr">{record.to_version}</dd>
          </div>
          <div>
            <dt>{t("carriedFiles.fromFolder")}</dt>
            <dd>
              {record.from_path != null ? (
                <code dir="ltr" className="break-all">
                  {record.from_path}
                </code>
              ) : (
                t("carriedFiles.folderUnavailable")
              )}
            </dd>
          </div>
          <div>
            <dt>{t("carriedFiles.toFolder")}</dt>
            <dd>
              <code dir="ltr" className="break-all">
                {record.to_path}
              </code>
            </dd>
          </div>
          {outcome.carried_bytes != null && (
            <div>
              <dt>{t("carriedFiles.copiedBytes")}</dt>
              <dd>{sizeLabel(outcome.carried_bytes)}</dd>
            </div>
          )}
          {outcome.required_bytes != null && (
            <div>
              <dt>{t("carriedFiles.requiredBytes")}</dt>
              <dd>{sizeLabel(outcome.required_bytes)}</dd>
            </div>
          )}
          {outcome.available_bytes != null && (
            <div>
              <dt>{t("carriedFiles.availableBytes")}</dt>
              <dd>{sizeLabel(outcome.available_bytes)}</dd>
            </div>
          )}
        </MetadataGrid>
        {!record.from_path && <p>{t("carriedFiles.sourceNotRechecked")}</p>}
        {populated.map((group) => {
          const count = outcome.counts?.[group.key];
          const known = count != null && Number.isSafeInteger(count) && count >= 0;
          return (
            <section key={group.key} aria-label={group.label} className="grid min-w-0 gap-2">
              <h4 className="m-0 text-sm font-semibold">{group.label}</h4>
              <p>
                {known ? t("carriedFiles.count", { value: count }) : t("carriedFiles.countUnknown")}
              </p>
              {group.paths.length > 0 && (
                <ul className="m-0 ps-5">
                  {group.paths.map((path) => (
                    <li key={path}>
                      <code dir="ltr" className="break-all">
                        {path}
                      </code>
                    </li>
                  ))}
                </ul>
              )}
              {(!known || count > group.paths.length) && <p>{t("carriedFiles.examplesOnly")}</p>}
            </section>
          );
        })}
        <p>{t("carriedFiles.historical")}</p>
      </div>
    </details>
  );
  const hasNotice =
    outcome.source_modified ||
    outcome.insufficient_space ||
    populated.some((group) => group.key !== "carried" && group.key !== "removed") ||
    (outcome.carried_bytes != null && outcome.carried_bytes > 256 * 1024 * 1024);
  if (!hasNotice) return details;
  return (
    <CurrentStateSummary title={t("carriedFiles.title")}>
      {outcome.source_modified && <p>{t("carriedFiles.sourceModified")}</p>}
      {outcome.insufficient_space && <p>{t("carriedFiles.insufficientSpace")}</p>}
      {(outcome.counts?.kept_separately ?? outcome.kept_separately.length) > 0 && (
        <p>{t("carriedFiles.differencesKept")}</p>
      )}
      {(outcome.counts?.source_unreadable ?? outcome.source_unreadable.length) > 0 && (
        <p>{t("carriedFiles.readFailed")}</p>
      )}
      {(outcome.counts?.new_version_ships_file ?? outcome.new_version_ships_file.length) > 0 && (
        <p>{t("carriedFiles.packageCopy")}</p>
      )}
      {outcome.carried_bytes != null && outcome.carried_bytes > 256 * 1024 * 1024 && (
        <p>{t("carriedFiles.largeCopy", { size: sizeLabel(outcome.carried_bytes) })}</p>
      )}
      {details}
    </CurrentStateSummary>
  );
}

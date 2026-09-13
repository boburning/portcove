import type { DoctorReport, PortDefinition } from "../types";
import { errorText, formatCountMessage } from "../view-model";

type Repair = DoctorReport["repair"];
type Item = Repair["items"][number];
const labels: Record<Item["kind"], string> = {
  partial_operation: "Unfinished operation",
  cleanup_pending: "Retained files need review",
  orphaned_final_directory: "Unregistered game folder",
  missing_registered_path: "Registered game folder is missing",
  degraded_backup: "Backup needs attention",
  backup_recovery_required: "Backup recovery needs review",
};
const countMessages = {
  zero: "No recovery items were recorded in the last check.",
  one: "1 recorded item needs review.",
  other: "{count} recorded items need review.",
  unknown: "Recovery information is unavailable.",
};

export function RecoveryReview({
  repair,
  ports,
  refreshing,
  stale,
  failure,
  refresh,
}: {
  repair?: Repair;
  ports: PortDefinition[];
  refreshing: boolean;
  stale: boolean;
  failure?: unknown;
  refresh: () => Promise<unknown>;
}) {
  const names = new Map(ports.map((port) => [port.id, port.name]));
  const state =
    refreshing && !repair
      ? "loading"
      : failure
        ? "failed"
        : stale && repair
          ? "stale"
          : repair
            ? "fresh"
            : "never-loaded";
  return (
    <section
      className="recovery-review"
      aria-label="Retained work and repairs"
      data-diagnostic-state={state}
    >
      <h2>Retained work and repairs</h2>
      {refreshing && (
        <p role="status">
          {repair
            ? "Refreshing recovery information. The last completed check remains visible."
            : "Checking the library for retained work and repairs…"}
        </p>
      )}
      {!refreshing && Boolean(failure) && (
        <p role="alert">
          Recovery information could not be refreshed: {errorText(failure)}
          {repair ? " The last completed check remains visible." : ""}
        </p>
      )}
      {!refreshing && !failure && stale && (
        <p role="status">
          {repair
            ? "Recovery information is out of date. The last completed check remains visible."
            : "Recovery information has not been checked for the current library state."}
        </p>
      )}
      {(!stale || repair) && <p>{formatCountMessage(repair?.items.length, countMessages)}</p>}
      {(stale || Boolean(failure)) && !refreshing && (
        <button data-focusable className="small-control" onClick={() => void refresh()}>
          Refresh recovery information
        </button>
      )}
      {!!repair?.items.length && (
        <>
          <p>
            Open an item to review its recorded location and recovery guidance. Opening these
            details does not change files.
          </p>
          <div className="recovery-review-list" data-focus-group>
            {repair.items.map((item, index) => (
              <details
                key={`${item.operation_id ?? item.port_id ?? "library"}:${item.kind}:${item.path}:${index}`}
                data-recovery-operation={item.operation_id ?? undefined}
              >
                <summary data-focusable>
                  {item.port_id ? (names.get(item.port_id) ?? item.port_id) : "Library"} ·{" "}
                  {Object.hasOwn(labels, item.kind)
                    ? labels[item.kind]
                    : "Recovery information needs review"}
                </summary>
                <dl>
                  <dt>Recorded location</dt>
                  <dd>{item.path ? <code>{item.path}</code> : "No location was recorded."}</dd>
                  <dt>Recorded guidance</dt>
                  <dd>{item.proposed_action || "No recovery guidance was recorded."}</dd>
                  {item.operation_id && (
                    <>
                      <dt>Operation reference</dt>
                      <dd>
                        <code>{item.operation_id}</code>
                      </dd>
                    </>
                  )}
                </dl>
              </details>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

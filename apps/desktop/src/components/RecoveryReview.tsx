import type { DoctorReport, PortDefinition } from "../types";
import { formatCountMessage } from "../view-model";

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
}: {
  repair?: Repair;
  ports: PortDefinition[];
}) {
  const names = new Map(ports.map((port) => [port.id, port.name]));
  return (
    <section className="recovery-review" aria-label="Retained work and repairs">
      <h2>Retained work and repairs</h2>
      <p>{formatCountMessage(repair?.items.length, countMessages)}</p>
      {!!repair?.items.length && (
        <>
          <p>
            Open an item to review its recorded location and recovery guidance.
            Opening these details does not change files.
          </p>
          <div className="recovery-review-list" data-focus-group>
            {repair.items.map((item, index) => (
              <details
                key={`${item.operation_id ?? item.port_id ?? "library"}:${item.kind}:${item.path}:${index}`}
                data-recovery-operation={item.operation_id ?? undefined}
              >
                <summary data-focusable>
                  {item.port_id
                    ? (names.get(item.port_id) ?? item.port_id)
                    : "Library"}{" "}
                  ·{" "}
                  {Object.hasOwn(labels, item.kind)
                    ? labels[item.kind]
                    : "Recovery information needs review"}
                </summary>
                <dl>
                  <dt>Recorded location</dt>
                  <dd>
                    {item.path ? (
                      <code>{item.path}</code>
                    ) : (
                      "No location was recorded."
                    )}
                  </dd>
                  <dt>Recorded guidance</dt>
                  <dd>
                    {item.proposed_action ||
                      "No recovery guidance was recorded."}
                  </dd>
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

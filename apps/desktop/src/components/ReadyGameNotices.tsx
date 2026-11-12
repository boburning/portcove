import { useEffect, useRef, useState } from "react";
import { desktopApi } from "../api";
import type { PortDefinition, PortIntentAssessment } from "../types";
import { Button } from "./ui/button";
import { onStandingSetupPass } from "../features/game-file-discovery/use-standing-setup";

/**
 * Games the player asked to hear about that became ready to install. Core
 * decides readiness and remembers what was already announced, so a notice
 * appears once per ready plan. Nothing here installs a game.
 */
export function ReadyGameNotices({
  generation,
  ports,
  onOpenPort,
}: {
  generation: number;
  ports: PortDefinition[];
  onOpenPort?: ((portId: string, originKey: string) => void) | undefined;
}) {
  const [ready, setReady] = useState<PortIntentAssessment[]>([]);
  const owner = useRef(generation);
  useEffect(() => {
    owner.current = generation;
  }, [generation]);
  useEffect(() => {
    const expected = generation;
    const assess = () =>
      desktopApi
        .assessPortIntents(expected)
        .then((assessed) => {
          if (owner.current !== expected) return;
          setReady(
            assessed.assessments.filter(
              (item) =>
                item.mode === "notify" && item.newly_ready && item.readiness.state === "ready",
            ),
          );
        })
        .catch(() => undefined);
    void assess();
    // Reassess after each standing-setup pass, which follows catalog, file and
    // choice changes.
    return onStandingSetupPass(() => void assess());
  }, [generation]);

  if (!ready.length) return null;
  const name = (id: string) => ports.find((port) => port.id === id)?.name ?? id;
  const dismiss = async (items: PortIntentAssessment[]) => {
    const acknowledgements = items.flatMap((item) =>
      item.readiness.state === "ready"
        ? [{ port_id: item.port_id, plan_sha256: item.readiness.plan_sha256 }]
        : [],
    );
    try {
      await desktopApi.acknowledgePortReadiness(acknowledgements, generation);
      if (owner.current === generation)
        setReady((current) => current.filter((item) => !items.includes(item)));
    } catch {
      // The notice stays until it can be recorded as seen.
    }
  };
  return (
    <section aria-label="Games ready to install" role="status" className="col-span-full">
      <h3>Ready to install</h3>
      <ul>
        {ready.map((item) => (
          <li key={item.port_id}>
            <strong>{name(item.port_id)}</strong> is ready to install.{" "}
            {onOpenPort && (
              <Button
                data-focusable
                variant="link"
                onClick={() => onOpenPort(item.port_id, "ready-game-notices")}
              >
                Review {name(item.port_id)} setup
              </Button>
            )}
            <Button data-focusable variant="ghost" onClick={() => void dismiss([item])}>
              Dismiss {name(item.port_id)}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

import { useEffect, useRef, useState } from "react";
import { Trans } from "react-i18next";
import { desktopApi } from "../api";
import { useAppTranslation } from "../localization";
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
  const { t } = useAppTranslation("gameFiles");
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
                item.mode === "notify" &&
                item.newly_ready &&
                (item.readiness.state === "ready" ||
                  (item.readiness.state === "installed" &&
                    Boolean(item.readiness.maintenance?.available_sha256))),
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
    const acknowledgements = items.flatMap((item) => {
      const key =
        item.readiness.state === "ready"
          ? item.readiness.plan_sha256
          : item.readiness.state === "installed"
            ? item.readiness.maintenance?.available_sha256
            : undefined;
      return key ? [{ port_id: item.port_id, plan_sha256: key }] : [];
    });
    try {
      await desktopApi.acknowledgePortReadiness(acknowledgements, generation);
      if (owner.current === generation)
        setReady((current) => current.filter((item) => !items.includes(item)));
    } catch {
      // The notice stays until it can be recorded as seen.
    }
  };
  return (
    <section aria-label={t("ready.label")} role="status" className="col-span-full">
      <h3>{t("ready.heading")}</h3>
      <ul>
        {ready.map((item) => (
          <li key={item.port_id}>
            {/* Game names and versions are exact values, never interpolated. */}
            {item.readiness.state !== "installed" ? (
              <Trans
                t={t}
                i18nKey="ready.installable"
                components={{
                  game: (
                    <strong>
                      <bdi>{name(item.port_id)}</bdi>
                    </strong>
                  ),
                }}
              />
            ) : item.readiness.maintenance?.available_version ? (
              <Trans
                t={t}
                i18nKey="ready.update"
                components={{
                  game: (
                    <strong>
                      <bdi>{name(item.port_id)}</bdi>
                    </strong>
                  ),
                  version: <bdi>{item.readiness.maintenance.available_version}</bdi>,
                }}
              />
            ) : (
              <Trans
                t={t}
                i18nKey="ready.updateUnknownVersion"
                components={{
                  game: (
                    <strong>
                      <bdi>{name(item.port_id)}</bdi>
                    </strong>
                  ),
                }}
              />
            )}{" "}
            {onOpenPort && (
              <Button
                data-focusable
                variant="link"
                onClick={() => onOpenPort(item.port_id, "ready-game-notices")}
              >
                {item.readiness.state === "installed" ? (
                  <Trans
                    t={t}
                    i18nKey="ready.reviewUpdate"
                    components={{ game: <bdi>{name(item.port_id)}</bdi> }}
                  />
                ) : (
                  <Trans
                    t={t}
                    i18nKey="ready.reviewSetup"
                    components={{ game: <bdi>{name(item.port_id)}</bdi> }}
                  />
                )}
              </Button>
            )}
            <Button data-focusable variant="ghost" onClick={() => void dismiss([item])}>
              <Trans
                t={t}
                i18nKey="ready.dismiss"
                components={{ game: <bdi>{name(item.port_id)}</bdi> }}
              />
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

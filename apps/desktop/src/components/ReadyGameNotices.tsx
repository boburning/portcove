import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Trans } from "react-i18next";
import { desktopApi } from "../api";
import { focusableControls, focusAndReveal } from "../focus";
import { useAppTranslation } from "../localization";
import type { PortDefinition, PortIntentAssessment } from "../types";
import type { DetailDestination } from "../view-model";
import { Button } from "./ui/button";
import { ActionRow } from "./ui/patterns";
import {
  onReadyNoticePreferenceChange,
  onStandingSetupPass,
} from "../features/game-file-discovery/use-standing-setup";

function noticeFor(assessment: PortIntentAssessment) {
  if (assessment.mode !== "notify" || !assessment.newly_ready) return [];
  const { readiness } = assessment;
  const sha =
    readiness.state === "ready"
      ? readiness.plan_sha256
      : readiness.state === "installed"
        ? readiness.maintenance?.available_sha256
        : undefined;
  return sha ? [{ assessment, sha, key: `${assessment.port_id}:${sha}` }] : [];
}

type ReadyNotice = ReturnType<typeof noticeFor>[number];
type NoticeScope = {
  generation: number;
  assessment: number;
  pending: Set<string>;
  notices: ReadyNotice[];
  acknowledgedThrough: Map<string, number>;
};

type OpenReadyNotice = (portId: string, originKey: string, destination: DetailDestination) => void;

/** Present the Core notices without changing install or update choices. */
export function ReadyGameNotices({
  generation,
  ports,
  onOpenPort,
  fallbackFocus,
}: {
  generation: number;
  ports: PortDefinition[];
  onOpenPort?: OpenReadyNotice | undefined;
  fallbackFocus?: (() => HTMLElement | null | undefined) | undefined;
}) {
  const [ready, setReady] = useState<{ generation: number; notices: ReadyNotice[] }>();
  const [dismissals, setDismissals] = useState<Record<string, "pending" | "failed">>({});
  const scope = useRef<NoticeScope | undefined>(undefined);
  const list = useRef<HTMLUListElement>(null);
  const returnFocus = useRef<
    { generation: number; trigger: HTMLElement; index: number } | undefined
  >(undefined);
  const { t } = useAppTranslation("gameFiles");
  const rememberRemovedFocus = useCallback(
    (removed: (key: string) => boolean) => {
      const trigger = document.activeElement;
      const rows = list.current;
      if (!(trigger instanceof HTMLElement) || !rows?.contains(trigger)) return;
      const row = trigger.closest<HTMLElement>("[data-ready-notice]");
      const key = row?.dataset.readyNotice;
      if (row && key && removed(key)) {
        const index = Array.from(rows.children).indexOf(row);
        returnFocus.current = { generation, trigger, index };
      }
    },
    [generation],
  );

  useEffect(() => {
    const current: NoticeScope = {
      generation,
      assessment: 0,
      pending: new Set(),
      notices: [],
      acknowledgedThrough: new Map(),
    };
    scope.current = current;
    const assess = () => {
      const call = ++current.assessment;
      return desktopApi
        .assessPortIntents(generation)
        .then(async (assessed) => {
          if (scope.current !== current || current.assessment !== call) return;
          const visited = new Set(assessed.assessments.map((assessment) => assessment.port_id));
          const earlier = current.notices.filter(
            (notice) => !visited.has(notice.assessment.port_id),
          );
          const saved =
            assessed.ready_notices_enabled !== false && assessed.not_assessed > 0 && earlier.length
              ? await desktopApi.portIntents(generation).catch(() => [])
              : [];
          if (scope.current !== current || current.assessment !== call) return;
          const stillNotifying = new Map(
            saved
              .filter(
                (intent) =>
                  intent.mode === "notify" &&
                  (intent.explicitly_uninstalled_at === undefined ||
                    intent.explicitly_uninstalled_at === null),
              )
              .map((intent) => [intent.port_id, intent]),
          );
          const notices = assessed.assessments
            .flatMap(noticeFor)
            .filter((notice) => (current.acknowledgedThrough.get(notice.key) ?? 0) < call);
          // A read started after acknowledgement can report the same release as newly ready.
          for (const [key, through] of current.acknowledgedThrough) {
            if (through < call) current.acknowledgedThrough.delete(key);
          }
          current.notices = [
            ...earlier.filter((notice) => {
              const intent = stillNotifying.get(notice.assessment.port_id);
              return Boolean(
                intent &&
                intent.acknowledged_plan_sha256 !== notice.sha &&
                current.notices.some((previous) => previous.key === notice.key),
              );
            }),
            ...notices,
          ];
          rememberRemovedFocus((key) => !current.notices.some((notice) => notice.key === key));
          setReady({ generation, notices: current.notices });
        })
        .catch(() => undefined);
    };
    void assess();
    const stopPass = onStandingSetupPass(() => void assess());
    const stopPreference = onReadyNoticePreferenceChange(() => void assess());
    return () => {
      scope.current = undefined;
      stopPass();
      stopPreference();
    };
  }, [generation, rememberRemovedFocus]);

  useLayoutEffect(() => {
    const waiting = returnFocus.current;
    if (!waiting) return;
    returnFocus.current = undefined;
    if (
      waiting.trigger.isConnected ||
      waiting.generation !== generation ||
      document.activeElement !== document.body
    )
      return;
    const rows = list.current?.children;
    const neighbor = rows?.item(waiting.index) ?? rows?.item(rows.length - 1);
    const nextControl = neighbor instanceof HTMLElement ? focusableControls(neighbor)[0] : null;
    focusAndReveal(nextControl ?? fallbackFocus?.());
  }, [fallbackFocus, generation, ready]);

  const notices = ready?.generation === generation ? ready.notices : [];
  if (!notices.length) return null;

  const dismiss = async (notice: ReadyNotice) => {
    const current = scope.current;
    if (
      current?.generation !== generation ||
      current.pending.has(notice.key) ||
      current.acknowledgedThrough.has(notice.key)
    )
      return;
    current.pending.add(notice.key);
    const statusKey = `${generation}:${notice.key}`;
    setDismissals((previous) => ({ ...previous, [statusKey]: "pending" }));
    try {
      await desktopApi.acknowledgePortReadiness(
        [{ port_id: notice.assessment.port_id, plan_sha256: notice.sha }],
        generation,
      );
      if (scope.current !== current) return;
      current.acknowledgedThrough.set(notice.key, current.assessment);
      rememberRemovedFocus((key) => key === notice.key);
      current.notices = current.notices.filter((item) => item.key !== notice.key);
      setReady({ generation, notices: current.notices });
      setDismissals((previous) => {
        const next = { ...previous };
        delete next[statusKey];
        return next;
      });
    } catch {
      if (scope.current === current)
        setDismissals((previous) => ({ ...previous, [statusKey]: "failed" }));
    } finally {
      current.pending.delete(notice.key);
    }
  };

  return (
    <section
      aria-label={t("ready.label")}
      role="status"
      aria-atomic="false"
      className="col-span-full grid min-w-0 gap-2"
    >
      <h3 className="text-base font-semibold">{t("ready.heading")}</h3>
      <ul ref={list} className="grid min-w-0 list-none gap-3 ps-0">
        {notices.map((notice) => (
          <ReadyNoticeRow
            key={notice.key}
            notice={notice}
            name={
              ports.find((port) => port.id === notice.assessment.port_id)?.name ??
              notice.assessment.port_id
            }
            dismissal={dismissals[`${generation}:${notice.key}`]}
            onOpenPort={onOpenPort}
            dismiss={() => void dismiss(notice)}
          />
        ))}
      </ul>
    </section>
  );
}

function ReadyNoticeRow({
  notice,
  name,
  dismissal,
  onOpenPort,
  dismiss,
}: {
  notice: ReadyNotice;
  name: string;
  dismissal: "pending" | "failed" | undefined;
  onOpenPort: OpenReadyNotice | undefined;
  dismiss: () => void;
}) {
  const { t } = useAppTranslation("gameFiles");
  const id = useId();
  const { port_id: portId, readiness } = notice.assessment;
  const installed = readiness.state === "installed";
  const version = installed ? readiness.maintenance?.available_version : undefined;
  const origin = `ready-game-notice:${notice.key}`;
  const pending = dismissal === "pending";
  const game = (
    <strong id={`${id}-game`}>
      <bdi>{name}</bdi>
    </strong>
  );
  return (
    <li
      className="grid min-w-0 gap-2 border-t border-pc-border pt-3"
      data-focus-group
      data-ready-notice={notice.key}
    >
      <p className="max-w-[65ch] text-sm wrap-anywhere">
        {/* Values stay exact and isolated from the translated sentence direction. */}
        {!installed ? (
          <Trans t={t} i18nKey="ready.installable" components={{ game }} />
        ) : version ? (
          <Trans
            t={t}
            i18nKey="ready.update"
            components={{ game, version: <bdi>{version}</bdi> }}
          />
        ) : (
          <Trans t={t} i18nKey="ready.updateUnknownVersion" components={{ game }} />
        )}
      </p>
      <ActionRow>
        {onOpenPort && (
          <Button
            data-focusable
            data-detail-origin={origin}
            variant="outline"
            size="sm"
            aria-labelledby={`${id}-review ${id}-game`}
            onClick={() => onOpenPort(portId, origin, installed ? "updates" : "files")}
          >
            <span id={`${id}-review`}>
              {t(installed ? "ready.reviewUpdate" : "ready.reviewSetup")}
            </span>
          </Button>
        )}
        <Button
          data-focusable
          variant="ghost"
          size="sm"
          aria-labelledby={`${id}-dismiss ${id}-game`}
          aria-busy={pending || undefined}
          focusableWhenDisabled
          onClick={dismiss}
        >
          <span id={`${id}-dismiss`}>{t(pending ? "ready.dismissing" : "ready.dismiss")}</span>
        </Button>
      </ActionRow>
      {dismissal === "failed" && (
        <p role="alert" className="text-sm text-pc-danger-foreground">
          {t("ready.dismissFailed")}
        </p>
      )}
    </li>
  );
}

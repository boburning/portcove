import { useCallback, useEffect, useRef, useState } from "react";
import { desktopApi } from "../../api";
import { listenDesktopEvent } from "../../desktop-events";
import type {
  ApplicationUpdateNoticeSnapshot,
  ApplicationUpdatePreferences,
  ApplicationUpdateProductionDecision,
  ApplicationUpdateProductionTransition,
} from "../../types";
import { LatestRequestGeneration } from "../../shared/concurrency-state";
import { startManagedSubscription } from "../../shared/subscription-lifecycle";
import { useApplicationUpdatePreferences } from "./use-application-update-preferences";

export function useApplicationUpdateChoice(reportError?: (error: unknown) => void) {
  const state = useApplicationUpdatePreferences();
  const { preferences, refresh } = state;
  const [dismissedPreferences, setDismissedPreferences] = useState<ApplicationUpdatePreferences>();
  useEffect(() => {
    let disposed = false;
    void refresh().catch((error: unknown) => {
      if (!disposed) reportError?.(error);
    });
    return () => {
      disposed = true;
    };
  }, [refresh, reportError]);
  const choiceRequired = Boolean(
    preferences && !preferences.choice && dismissedPreferences !== preferences,
  );
  const dismiss = useCallback(() => {
    if (preferences && !preferences.choice) setDismissedPreferences(preferences);
  }, [preferences]);
  return { ...state, choiceRequired, dismiss };
}

export function useApplicationUpdateProductionTransition({
  preferences,
  acceptPreferences,
  refreshPreferences,
  reportError,
}: {
  preferences: ApplicationUpdatePreferences | undefined;
  acceptPreferences: (preferences: ApplicationUpdatePreferences) => void;
  refreshPreferences: () => Promise<ApplicationUpdatePreferences>;
  reportError?: (error: unknown) => void;
}) {
  const requests = useRef(new LatestRequestGeneration());
  const actions = useRef(new LatestRequestGeneration());
  const [boundSnapshot, setSnapshot] = useState<{
    preferences: ApplicationUpdatePreferences;
    value: ApplicationUpdateProductionTransition;
  }>();
  const snapshot = boundSnapshot?.value;
  const [busy, setBusy] = useState(false);
  const [dismissedPreferences, setDismissedPreferences] = useState<ApplicationUpdatePreferences>();
  const preferenceRevision = preferences?.revision;

  useEffect(() => {
    const tracker = actions.current;
    return () => {
      tracker.begin();
    };
  }, []);

  useEffect(() => {
    const tracker = requests.current;
    if (!preferences) return;
    const request = tracker.begin();
    void desktopApi
      .applicationUpdateProductionTransition()
      .then((next) => {
        if (tracker.isCurrent(request)) setSnapshot({ preferences, value: next });
      })
      .catch((error: unknown) => {
        if (tracker.isCurrent(request)) reportError?.(error);
      });
    return () => {
      tracker.begin();
    };
  }, [preferences, reportError]);

  const complete = useCallback(
    async (decision: ApplicationUpdateProductionDecision) => {
      if (preferenceRevision === undefined) return false;
      const request = actions.current.begin();
      setBusy(true);
      try {
        const result = await desktopApi.completeApplicationUpdateProductionTransition(
          preferenceRevision,
          decision,
        );
        if (!actions.current.isCurrent(request)) return false;
        acceptPreferences(result.preferences);
        setSnapshot({ preferences: result.preferences, value: result.transition });
        return true;
      } catch (error) {
        if (!actions.current.isCurrent(request)) return false;
        reportError?.(error);
        try {
          const [currentPreferences, currentTransition] = await Promise.all([
            refreshPreferences(),
            desktopApi.applicationUpdateProductionTransition(),
          ]);
          if (actions.current.isCurrent(request)) {
            // refreshPreferences already publishes through the shared owner.
            setSnapshot({ preferences: currentPreferences, value: currentTransition });
          }
        } catch {
          // The original typed error remains the actionable report.
        }
        return false;
      } finally {
        if (actions.current.isCurrent(request)) setBusy(false);
      }
    },
    [acceptPreferences, refreshPreferences, preferenceRevision, reportError],
  );

  const offerRequired = Boolean(
    snapshot?.offer_required &&
    boundSnapshot?.preferences === preferences &&
    snapshot.preference_revision === preferenceRevision &&
    dismissedPreferences !== preferences,
  );
  const dismiss = useCallback(() => {
    if (snapshot?.offer_required) setDismissedPreferences(preferences);
  }, [snapshot, preferences]);
  return { snapshot, offerRequired, busy, complete, dismiss };
}

export function useApplicationUpdateNotice(reportError?: (error: unknown) => void) {
  const [snapshot, setSnapshot] = useState<ApplicationUpdateNoticeSnapshot>();
  const accept = useCallback((next: ApplicationUpdateNoticeSnapshot) => {
    setSnapshot((current) => (!current || next.revision >= current.revision ? next : current));
  }, []);
  useEffect(() => {
    let disposed = false;
    const subscription = startManagedSubscription<ApplicationUpdateNoticeSnapshot>({
      register: (acceptEvent) =>
        listenDesktopEvent("portcove://application-update-notice", acceptEvent),
      onEvent: accept,
    });
    void (async () => {
      await subscription.ready;
      if (disposed) return;
      try {
        accept(await desktopApi.applicationUpdateNotice());
      } catch {
        /* Settings owns actionable updater-state recovery; this surface is optional. */
      }
    })();
    return () => {
      disposed = true;
      subscription.stop();
    };
  }, [accept]);
  const dismiss = useCallback(async () => {
    if (!snapshot?.notice) return;
    try {
      accept(await desktopApi.dismissApplicationUpdateNotice(snapshot.revision));
    } catch (error) {
      reportError?.(error);
    }
  }, [accept, reportError, snapshot]);
  return { snapshot, notice: snapshot?.notice, dismiss };
}

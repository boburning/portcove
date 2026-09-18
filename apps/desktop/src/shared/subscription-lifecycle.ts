export type SubscriptionDisposer = () => void | Promise<void>;

export function startManagedSubscription<T>({
  register,
  onEvent,
  onFailure,
}: {
  register: (accept: (payload: T) => void) => Promise<SubscriptionDisposer>;
  onEvent: (payload: T) => void;
  onFailure?: (error: unknown) => void;
}) {
  let stopped = false;
  let dispose: SubscriptionDisposer | undefined;

  const safelyDispose = (current: SubscriptionDisposer) => {
    try {
      void Promise.resolve(current()).catch((error: unknown) => {
        if (!stopped) onFailure?.(error);
      });
    } catch (error) {
      if (!stopped) onFailure?.(error);
    }
  };

  const ready = Promise.resolve()
    .then(() => register((payload) => !stopped && onEvent(payload)))
    .then((registered) => {
      if (stopped) safelyDispose(registered);
      else dispose = registered;
      return !stopped;
    })
    .catch((error: unknown) => {
      if (!stopped) onFailure?.(error);
      return false;
    });

  return {
    ready,
    stop() {
      stopped = true;
      if (dispose) {
        const current = dispose;
        dispose = undefined;
        safelyDispose(current);
      }
    },
  };
}

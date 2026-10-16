const backupSectionSelector = '[aria-labelledby="detail-saves-and-storage"]';
export const degradedInventorySelector = `${backupSectionSelector} .backup-history[data-backup-read-state="current"] .backup-inventory-notice.degraded`;

/**
 * @template T
 * @param {{readNotices: () => Promise<T[]>, readProblems: (notice: T) => Promise<unknown[]>, wait: (probe: () => Promise<T | false>, timeout: number, message: string) => Promise<T | false>}} observer
 * @param {number} problemCount
 */
export function waitForDegradedInventory(observer, problemCount) {
  return observer.wait(
    async () => {
      const notices = await observer.readNotices();
      if (notices.length !== 1) return false;
      const actions = await observer.readProblems(notices[0]);
      return actions.length === problemCount ? notices[0] : false;
    },
    15_000,
    "Fresh degraded backup inventory must finish loading",
  );
}

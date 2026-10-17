const backupSectionSelector = '[aria-labelledby="detail-saves-and-storage"]';
export const degradedInventorySelector = `${backupSectionSelector} .backup-history[data-backup-read-state="current"] .backup-inventory-notice.degraded`;

export interface BackupInventoryObserver<Notice> {
  readNotices(): Promise<Notice[]>;
  readProblems(notice: Notice): Promise<unknown[]>;
  wait(
    probe: () => Promise<Notice | false>,
    timeout: number,
    message: string,
  ): Promise<Notice | false>;
}
export function waitForDegradedInventory<Notice>(
  observer: BackupInventoryObserver<Notice>,
  problemCount: number,
) {
  return observer.wait(
    async () => {
      const notices = await observer.readNotices();
      const notice = notices[0];
      if (notices.length !== 1 || notice === undefined) return false;
      const actions = await observer.readProblems(notice);
      return actions.length === problemCount ? notice : false;
    },
    15_000,
    "Fresh degraded backup inventory must finish loading",
  );
}

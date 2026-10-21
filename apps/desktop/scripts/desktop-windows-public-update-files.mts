/** Windows API aliases. Fixed on-disk staging leaf names are shared by the
 * shipping Windows and Linux updater; no platform-selected arbitrary paths. */
export {
  retainPublicUpdatePreimages as retainWindowsPublicUpdatePreimages,
  preparePublicJournalFault as prepareWindowsPublicJournalFault,
  preparePublicPayloadFault as prepareWindowsPublicPayloadFault,
} from "./desktop-public-update-files.mts";

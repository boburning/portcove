import { checkStagedFiles } from "./scripts/precommit-check.mjs";

export default {
  "*": {
    title: "Check staged source (no fixes)",
    task: async (files) => checkStagedFiles(files),
  },
};

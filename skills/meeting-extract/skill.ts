/**
 * Official meeting-extract entry. Executed only inside apps/skill-runner (child process).
 * No network, no source secrets, never write back to editors.
 */
export { meetingExtractHandler as handler } from "../../packages/skills-runtime/src/meeting-extract.ts";
export const skillId = "meeting-extract";
export const hooks = ["post-sync"] as const;
export const noNetwork = true;

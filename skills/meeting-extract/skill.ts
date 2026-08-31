/**
 * Official meeting-extract helper.
 * P1 runs in-process via @note-hub/skills-runtime (api / worker).
 * No network, no source secrets, never write back to editors.
 */
export const skillId = "meeting-extract";
export const hooks = ["post-sync"] as const;
export const noNetwork = true;

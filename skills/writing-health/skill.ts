/**
 * Official writing-health helper.
 * P1 runs in-process via @note-hub/skills-runtime (api / worker).
 * No network, no source secrets, never write back to editors.
 */
export const skillId = "writing-health";
export const hooks = ["weekly-report", "on-ask"] as const;
export const noNetwork = true;

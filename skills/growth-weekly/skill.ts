/**
 * Official growth-weekly helper.
 * P1 runs in-process via @note-hub/skills-runtime (api / worker).
 * No network, no source secrets, never write back to editors.
 */
export const skillId = "growth-weekly";
export const hooks = ["post-sync", "on-ask", "weekly-report"] as const;
export const noNetwork = true;

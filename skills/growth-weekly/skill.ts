/**
 * Official growth-weekly entry. Executed only inside apps/skill-runner (child process).
 * No network, no source secrets, never write back to editors.
 */
export { growthWeeklyHandler as handler } from "../../packages/skills-runtime/src/growth-weekly.ts";
export const skillId = "growth-weekly";
export const hooks = ["post-sync", "on-ask", "weekly-report"] as const;
export const noNetwork = true;

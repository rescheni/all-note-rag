/**
 * Official writing-health entry. Executed only inside apps/skill-runner (child process).
 * No network, no source secrets, never write back to editors.
 */
export { writingHealthHandler as handler } from "../../packages/skills-runtime/src/writing-health.ts";
export const skillId = "writing-health";
export const hooks = ["weekly-report", "on-ask"] as const;
export const noNetwork = true;

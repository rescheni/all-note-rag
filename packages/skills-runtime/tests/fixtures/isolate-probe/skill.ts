import type { SkillHandler } from "../../../src/types.ts";

export const handler: SkillHandler = async (input) => {
  if (input.payload?.hang) {
    await new Promise(() => {});
  }
  return {
    ok: true,
    extra: {
      env_keys: Object.keys(process.env).sort(),
      pid: process.pid,
      probe: true,
    },
  };
};

export const GROWTH_PERSONAL_ONLY_CODE = "growth_personal_only" as const;
export const GROWTH_PERSONAL_ONLY_MESSAGE = "成长分析仅用于个人空间";

export type GrowthAccessError = {
  code: typeof GROWTH_PERSONAL_ONLY_CODE;
  message: string;
};

/** Team spaces must never read or write GrowthEvent. */
export function growthAccessError(spaceKind: string | null | undefined): GrowthAccessError | null {
  if (spaceKind === "personal") return null;
  return { code: GROWTH_PERSONAL_ONLY_CODE, message: GROWTH_PERSONAL_ONLY_MESSAGE };
}

export function isPersonalSpace(spaceKind: string | null | undefined): boolean {
  return spaceKind === "personal";
}

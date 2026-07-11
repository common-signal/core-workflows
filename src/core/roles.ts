export type RoleName = "Prototyper" | "Builder" | "Sweeper" | "Grower" | "Maintainer";

export type RoleOption = {
  readonly role: RoleName;
  readonly description: string;
  readonly signal: string;
  readonly localModel: "engine-default" | "llama3-8b-instruct-q4";
  readonly cloudModel: string;
  readonly cloudBridgeRecommendedBelowGb?: number;
};

export const DEFAULT_ROLE: RoleName = "Builder";
export const HEAVY_ROLE_RAM_THRESHOLD_GB = 32;

export const ROLE_OPTIONS: readonly RoleOption[] = [
  {
    role: "Prototyper",
    description: "Explore a first pass, test feasibility, and make the idea visible.",
    signal: "Quick version, clear learning.",
    localModel: "engine-default",
    cloudModel: "gemini-1.5-pro"
  },
  {
    role: "Builder",
    description: "Implement planned work, wire structure, and keep behavior testable.",
    signal: "Known direction, careful execution.",
    localModel: "engine-default",
    cloudModel: "claude-3-5-sonnet-latest"
  },
  {
    role: "Sweeper",
    description: "Clean, migrate, deduplicate, and make the system easier to change.",
    signal: "Working system, cleaner shape.",
    localModel: "engine-default",
    cloudModel: "claude-3-5-sonnet-latest"
  },
  {
    role: "Grower",
    description: "Expand a working foundation through product surface, docs, and scale paths.",
    signal: "Existing seed, stronger surface.",
    localModel: "llama3-8b-instruct-q4",
    cloudModel: "gemini-1.5-pro"
  },
  {
    role: "Maintainer",
    description: "Protect reliability, security posture, operating checks, and regressions.",
    signal: "Stable baseline, visible health.",
    localModel: "llama3-8b-instruct-q4",
    cloudModel: "gpt-4o",
    cloudBridgeRecommendedBelowGb: HEAVY_ROLE_RAM_THRESHOLD_GB
  }
];

export function getRoleOption(role: RoleName): RoleOption {
  const option = ROLE_OPTIONS.find((candidate) => candidate.role === role);

  if (!option) {
    throw new Error(`Unsupported Common Signal role: ${role}.`);
  }

  return option;
}

export function shouldRecommendCloudBridge(
  role: RoleName,
  totalRamGb: number,
  localOverride: boolean
): boolean {
  if (localOverride) {
    return false;
  }

  const threshold = getRoleOption(role).cloudBridgeRecommendedBelowGb;

  return threshold !== undefined && totalRamGb < threshold;
}

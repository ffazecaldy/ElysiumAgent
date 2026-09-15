/**
 * @elysium/cli — wiring: config, provider selection, command entry points.
 */
export {
  loadConfig,
  saveEnvValue,
  describeConfig,
  PROVIDER_NAMES,
  PROVIDER_MODELS,
  PROVIDER_URLS,
} from "./config";
export type { ProviderConfig, ProviderName } from "./config";
export { runDemo, runOrchestrate, runTask } from "./commands";
export { runSwarmGoal, planGoal } from "./swarm-mode";
export type { RunSwarmGoalOptions, SwarmEvent, SwarmGoalReport, SwarmPlan } from "./swarm-mode";
export { collectSkills, skillRoots, skillsPromptBlock } from "./skills";
export type { SkillEntry } from "./skills";

export const CLI_VERSION = "0.1.0";

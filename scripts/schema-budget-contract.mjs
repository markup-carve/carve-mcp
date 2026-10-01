import { describeContractDrift } from './release-contract.mjs';

export function validateBudgetScenario({ label, profile, maximum, tools, workspace }, profiles) {
  if (!profiles.includes(profile)) throw new Error(`Schema budget scenario ${label} has an unknown profile.`);
  if (!Number.isFinite(maximum) || !Number.isInteger(maximum) || maximum <= 0) {
    throw new Error(`Schema budget scenario ${label} needs a positive numeric maximum.`);
  }
  if (typeof workspace !== 'boolean') throw new Error(`Schema budget scenario ${label} needs a workspace flag.`);
  if (!Array.isArray(tools) || tools.length === 0 || tools.some((name) => typeof name !== 'string' || !name)
      || new Set(tools).size !== tools.length) {
    throw new Error(`Schema budget scenario ${label} needs a unique list of expected tool names.`);
  }
}

export function assertBudgetToolNames(label, expected, actual) {
  const drift = describeContractDrift(expected, actual);
  if (drift) throw new Error(`Schema budget scenario ${label} has tool contract drift. ${drift}`);
}

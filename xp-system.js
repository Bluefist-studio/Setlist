export const XP_AWARDS = Object.freeze({
  startWorkout: 5,
  completeWorkout: 50,
  completeSet: 5,
  completeExercise: 10,
  newExercise: 15,
  beatPrevious: 15,
  personalBest: 25,
  savedWorkout: 10,
  streak3: 25,
  streak7: 50,
  streak14: 100,
  streak30: 200
});

const LEVEL_THRESHOLDS = [0, 250, 600, 1000, 1500, 2100, 2800, 3600, 4500, 5500];

export function xpThresholdForLevel(level) {
  const safeLevel = Math.max(1, Math.floor(Number(level) || 1));
  if (safeLevel <= LEVEL_THRESHOLDS.length) return LEVEL_THRESHOLDS[safeLevel - 1];
  let threshold = LEVEL_THRESHOLDS.at(-1);
  let nextIncrement = 1100;
  for (let currentLevel = LEVEL_THRESHOLDS.length + 1; currentLevel <= safeLevel; currentLevel++) {
    threshold += nextIncrement;
    nextIncrement += 100;
  }
  return threshold;
}

export function xpLevelFromTotal(totalXp) {
  const xp = Math.max(0, Number(totalXp) || 0);
  let level = 1;
  while (xp >= xpThresholdForLevel(level + 1)) level++;
  return level;
}

export function xpProgressInLevel(totalXp) {
  const xp = Math.max(0, Number(totalXp) || 0);
  return xp - xpThresholdForLevel(xpLevelFromTotal(xp));
}

export function xpNeededForNextLevel(totalXp) {
  const level = xpLevelFromTotal(totalXp);
  return xpThresholdForLevel(level + 1) - xpThresholdForLevel(level);
}

export function calculateXpMultiplier(actualDuration, estimatedDuration) {
  const actual = Number(actualDuration);
  const estimated = Number(estimatedDuration);
  if (!Number.isFinite(actual) || !Number.isFinite(estimated) || estimated <= 0) return 1;
  const ratio = Math.max(0, actual) / estimated;
  if (ratio >= 0.6) return 1;
  if (ratio >= 0.4) return 0.75;
  if (ratio >= 0.2) return 0.5;
  return 0;
}
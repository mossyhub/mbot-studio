import { readProgramEvidence, agreesWithServer } from './program-evidence.js';
import { CHALLENGES, evaluateChallenge } from './challenge-curriculum.js';
import { checkProgramAchievements } from './achievements.js';
const key = profileId => `mbot-studio-challenges:${profileId || 'default'}`;
export function getChallengeProgress(profileId) {
  try { return JSON.parse(localStorage.getItem(key(profileId)) || '{}'); } catch { return {}; }
}
export function captureSubmission({ blocks, profileId, robotConfig }) {
  return { blocks: structuredClone(blocks), profileId, robotConfig: structuredClone(robotConfig || {}) };
}
export function acceptSubmission(run, response) {
  run.response = structuredClone(response);
  try { run.evidence = readProgramEvidence(run.blocks); run.verified = agreesWithServer(run.evidence, response); } catch { run.verified = false; }
}
export function cancelSubmission(run) { if (run) run.done = true; }
export function completeSubmission(run, event, profileId) {
  const empty = { challenges: [], badges: [] };
  if (run.done || event.type !== 'program' || !event.run_id || event.run_id !== run.response?.run_id) return empty;
  if (!['completed','failed','canceled'].includes(event.event)) return empty;
  run.done = true;
  if (!run.verified || event.event !== 'completed' || profileId !== run.profileId) return empty;
  // Persistent deduplication survives remounts and duplicate run observations.
  const ledgerKey = `mbot-studio-verified-runs:${run.profileId}`;
  let ids; try { ids = JSON.parse(localStorage.getItem(ledgerKey) || '[]'); } catch { ids = []; }
  if (ids.includes(event.run_id)) return empty;
  const state = getChallengeProgress(run.profileId);
  const challenges = CHALLENGES.filter(c => !Object.hasOwn(state,c.id) && evaluateChallenge(c,run.evidence,run.robotConfig).every(g=>g.done));
  for (const c of challenges) state[c.id] = { stars: c.stars, completedAt: Date.now(), verification: 'device-completed', runId: event.run_id };
  localStorage.setItem(key(run.profileId), JSON.stringify(state));
  const badges = checkProgramAchievements(run.blocks, {confirmed:true,profileId:run.profileId,runId:event.run_id,evidence:run.evidence,newChallenges:challenges,allExplorer:CHALLENGES.filter(c=>c.level===1).every(c=>state[c.id])});
  localStorage.setItem(ledgerKey, JSON.stringify([...ids,event.run_id]));
  return { challenges, badges };
}

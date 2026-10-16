import React, { useState, useEffect } from 'react';
import { CHALLENGES, LEVELS, LEGACY_CHALLENGES, challengeAvailability, evaluateChallenge } from '../services/challenge-curriculum.js';
import { getChallengeProgress } from '../services/challenge-progress.js';
import { readProgramEvidence } from '../services/program-evidence.js';
import './Challenges.css';
const earnedLabel = entry => !entry ? 'Ready to try' : entry.verification === 'device-completed' ? '✓ Device-confirmed' : '✓ Previously earned';
export function MissionStrip({ challenge, blocks, currentProfileId, robotConfig, onClose, onViewChallenges }) {
  if (!challenge) return null;
  const earned = getChallengeProgress(currentProfileId)[challenge.id];
  let goals=challenge.goals.map(g=>({label:g.label,done:false}));
  try { goals=evaluateChallenge(challenge,readProgramEvidence(blocks),robotConfig); } catch { /* not ready */ }
  return <section className="mission-strip" data-testid="mission-strip" aria-label="Active mission">
    <div className="mission-strip-heading"><span>{challenge.icon} <strong>{challenge.title}</strong> · Level {challenge.level}</span><span className="mission-state" role="status">{earned ? earnedLabel(earned) : 'Draft checklist · credit after device completion'}</span><button className="mission-link" onClick={onViewChallenges}>View missions</button><button className="mission-link" aria-label="Dismiss mission" onClick={onClose}>×</button></div>
    <ul className="mission-checklist">{goals.map(g=><li key={g.label}><span aria-hidden="true">{earned || g.done ? '✓' : '○'}</span> {g.label}{!earned&&g.done&&<small> · in draft</small>}</li>)}</ul>
    <details className="mission-hint"><summary>Need a hint?</summary><p>{challenge.hint}</p>{challenge.safety&&<p>{challenge.safety}</p>}</details>
  </section>;
}
export default function Challenges({ currentProfileId, robotConfig, onLoadProgram, progressVersion }) {
  const [level,setLevel]=useState(1),[selected,setSelected]=useState(null);
  useEffect(()=>{setSelected(null);},[currentProfileId]);
  const completed=getChallengeProgress(currentProfileId);
  const activeCount=CHALLENGES.filter(c=>completed[c.id]).length;
  const stars=Object.values(completed).reduce((n,c)=>n+(c.stars||0),0);
  const legacy=Object.entries(completed).filter(([id])=>!CHALLENGES.some(c=>c.id===id));
  const focus=CHALLENGES.find(c=>c.id===selected);
  const available=focus&&challengeAvailability(focus,robotConfig);
  return <div className="challenges-panel" data-progress-version={progressVersion}>
    <header className="mission-hero"><div><span className="mission-eyebrow">YOUR ROBOT LAB</span><h2>Small missions. Big ideas.</h2><p>Build it. Run it. Let your robot confirm it.</p></div><div className="mission-score"><strong>{activeCount}<span> / {CHALLENGES.length}</span></strong><span>missions earned</span><b>☆ {stars} stars, including history</b></div></header>
    <p className="mission-explainer">No “I Did It” button needed. A matching, completed program earns credit automatically — even if you were not working on that mission. Device confirmation checks code, not physical accuracy.</p>
    <nav className="mission-levels" aria-label="Mission levels">{LEVELS.map(l=><button key={l.id} aria-pressed={level===l.id} className={`mission-level level-${l.id}`} onClick={()=>{setLevel(l.id);setSelected(null);}}><span>LEVEL {l.id}</span><strong>{l.name}</strong><small>{l.subtitle.split(' · ')[1]}</small><span>{CHALLENGES.filter(c=>c.level===l.id&&completed[c.id]).length} / {CHALLENGES.filter(c=>c.level===l.id).length} earned</span></button>)}</nav>
    {focus&&<section className="challenge-detail" aria-label={`${focus.title} mission details`}>
      <div className="challenge-detail-top"><div><span className="mission-eyebrow">LEVEL {focus.level} · {focus.stars} STAR{focus.stars>1?'S':''}</span><h3>{focus.icon} {focus.title}</h3><p>{focus.description}</p></div><button className="mission-link" aria-label="Close mission details" onClick={()=>setSelected(null)}>×</button></div>
      <h4>Your programming goals</h4><ul className="mission-checklist">{focus.goals.map(g=><li key={g.label}>○ {g.label}</li>)}</ul>
      {focus.safety&&<p className="mission-safety">{focus.safety}</p>}
      <details className="mission-hint"><summary>Show hint</summary><p>{focus.hint}</p></details>
      {focus.observation&&<p className="mission-observation">{focus.observation}</p>}
      <div className="challenge-actions"><button className="btn-primary" disabled={!!available} onClick={()=>onLoadProgram?.(focus)}>Start Programming</button><span>{available||earnedLabel(completed[focus.id])}</span></div><small>Loads an unfinished starter into Program. Save your current work first.</small>
    </section>}
    <div className="challenges-grid">{CHALLENGES.filter(c=>c.level===level).map((c,i)=><button key={c.id} className={`challenge-card ${completed[c.id]?'done':''} ${selected===c.id?'active':''}`} onClick={()=>setSelected(c.id)} aria-expanded={selected===c.id}>
      <span className={`challenge-card-icon level-${c.level}`}>{c.icon}</span><span className="challenge-card-info"><small>MISSION {String(i+1).padStart(2,'0')} · {c.stars} STAR{c.stars>1?'S':''}</small><strong>{c.title}</strong><span>{c.description}</span><small className="mission-card-state">{challengeAvailability(c,robotConfig)||earnedLabel(completed[c.id])}</small></span><span aria-hidden="true">→</span>
    </button>)}</div>
    <footer className="mission-footer">Start with Explorer, then try Builder and Inventor. All levels are open: learn at your own pace. Progress stays with this child profile, in this browser.</footer>
    {legacy.length>0&&<details className="mission-legacy"><summary>Legacy collection · {legacy.length} past missions</summary><p>Kept exactly as earned. These retired missions are not rechecked or newly awarded by this runtime.</p>{legacy.map(([id,entry])=><p key={id}>{LEGACY_CHALLENGES[id]||id} · {entry.stars||0} stars · Legacy</p>)}</details>}
  </div>;
}

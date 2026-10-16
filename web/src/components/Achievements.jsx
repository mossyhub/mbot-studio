import React, { useState } from 'react';
import { BADGES, getEarnedBadgeObjects, getProgress } from '../services/achievements.js';
import './Achievements.css';
const CATEGORIES=[['all','All badges'],['coding','Programming'],['operators','Number skills'],['creative','Sound & screen'],['challenges','Missions'],['studio','Studio']];
export default function Achievements({currentProfileId}) {
 const [category,setCategory]=useState('all');
 const progress=getProgress(currentProfileId),earned=getEarnedBadgeObjects(currentProfileId),current=earned.filter(b=>!b.legacy),ids=new Set(current.map(b=>b.id)),legacy=earned.filter(b=>b.legacy);
 return <div className="achievements-panel">
  <header className="achievements-header"><div><span className="achievement-eyebrow">YOUR COLLECTION</span><h2>Look what you can do.</h2><p>Skills earned through making, not just clicking Run.</p></div><div className="achievements-count"><strong>{progress.earned} / {progress.total}</strong><span>current badges earned</span></div></header>
  <div className="achievements-stats"><span><strong>{progress.stats.verified_runs||0}</strong> device-confirmed programs</span><span><strong>{progress.stats.distinct_programs||0}</strong> distinct programs</span><span><strong>{progress.stats.stars_earned||0}</strong> stars, including history</span></div>
  <p className="achievement-note">Programming badges need a matching device-completed run. Drafts, failed runs and duplicate events do not count. Studio badges record app actions, not robot execution. Older earned dates and totals stay intact.</p>
  <nav className="achievements-categories" aria-label="Badge categories">{CATEGORIES.map(([id,label])=><button key={id} aria-pressed={category===id} onClick={()=>setCategory(id)}>{label}</button>)}</nav>
  <div className="achievements-grid">{BADGES.filter(b=>category==='all'||b.category===category).map(b=><article key={b.id} className={`achievement-card ${ids.has(b.id)?'earned':''}`}><span className="achievement-icon" aria-hidden="true">{b.icon}</span><div><span className="achievement-status">{ids.has(b.id)?'✓ EARNED':'NEXT TO DISCOVER'}</span><h3>{b.name}</h3><p>{b.description}</p>{ids.has(b.id)&&<small>Earned {new Date(current.find(e=>e.id===b.id).earnedAt).toLocaleDateString()}</small>}</div></article>)}</div>
  {legacy.length>0&&<section className="achievement-legacy"><h3>Legacy collection · {legacy.length}</h3><p>These badges are yours to keep. Their original goals and earned dates are preserved separately from current criteria, not promises about this robot.</p><div className="achievements-grid">{legacy.map(b=><article className="achievement-card" key={b.id}><span className="achievement-icon">🏵️</span><div><span className="achievement-status">LEGACY · EARNED</span><h3>{b.name}</h3><p>{b.description}</p>{b.hint&&b.hint!==b.description&&<p>Original hint: {b.hint}</p>}<small>{new Date(b.earnedAt).toLocaleDateString()}</small></div></article>)}</div></section>}
 </div>;
}

import React, { useState } from 'react';
import { playClick } from '../services/sound-service';
import { TEMPLATES, resolveTemplateBlocks, templateUnavailableReason } from '../services/program-templates';
import './TemplateGallery.css';

const CATEGORIES = [{ key:'all',label:'📚 All' },{ key:'fun',label:'🎉 Sound & lights' },{ key:'movement',label:'🚗 Movement' },{ key:'sensors',label:'📡 Sensor projects' }];

export default function TemplateGallery({ onLoadTemplate, robotConfig, robotStatus }) {
  const [category,setCategory] = useState('all');
  const [selectedId,setSelectedId] = useState(null);
  const selected = TEMPLATES.find(t => t.id === selectedId);
  const reason = selected ? templateUnavailableReason(selected,robotConfig,robotStatus) : '';
  const runnableCount = TEMPLATES.filter(t => !templateUnavailableReason(t,robotConfig,robotStatus)).length;
  const filtered = TEMPLATES.filter(t => category === 'all' || t.category === category);
  const load = () => {
    if (!selected || reason) return;
    playClick();
    onLoadTemplate?.(resolveTemplateBlocks(selected,robotConfig),selected.name);
  };
  return <div className="template-gallery">
    <div className="template-header"><h3>📚 Program Templates</h3><span className="template-count">{runnableCount} checked examples · Run validates current values</span></div>
    <div className="template-categories">{CATEGORIES.map(c => <button key={c.key} className={`tmpl-cat-btn ${category===c.key?'tmpl-cat-active':''}`} onClick={()=>setCategory(c.key)}>{c.label}</button>)}</div>
    {selected && <div className="template-detail">
      <div className="template-detail-header"><span className="template-detail-icon">{selected.icon}</span><div className="template-detail-info"><strong>{selected.name}</strong><p>{selected.description}</p><span className="template-difficulty">{selected.difficulty}</span></div></div>
      {reason && <p role="status" className="template-unavailable">{reason}</p>}
      {!reason && <p>Loading only edits your program. Check the area before pressing Run.</p>}
      <div className="template-detail-actions"><button className="btn-primary" disabled={!!reason} onClick={load}>✨ Load This Program</button><button className="btn-secondary btn-small" onClick={()=>setSelectedId(null)}>Close</button></div>
    </div>}
    <div className="template-grid">{filtered.map(t => {
      const unavailable = templateUnavailableReason(t,robotConfig,robotStatus);
      return <button key={t.id} className={`template-card ${selectedId===t.id?'template-card-active':''}`} onClick={()=>setSelectedId(t.id)}>
        <span className="template-card-icon">{t.icon}</span><div className="template-card-info"><span className="template-card-name">{t.name}</span><span className="template-card-desc">{t.description}</span><span className="template-card-meta">{unavailable?'Not available — see details':t.difficulty}</span></div>
      </button>;
    })}</div>
  </div>;
}

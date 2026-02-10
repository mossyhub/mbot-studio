import React, { useState, useEffect, useRef } from 'react';
import './Header.css';

export default function Header({
  activeTab, onTabChange, robotConnected, robotStatus,
  models, currentModel, onModelChange, modelsLoading,
  projectName, onProjectSave, onProjectLoad, onProjectNew, savedProjects,
  achievementCount, achievementTotal, soundMuted, onSoundToggle,
}) {
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showProjectMenu, setShowProjectMenu] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState(projectName || '');
  const pickerRef = useRef(null);
  const projectRef = useRef(null);
  const nameInputRef = useRef(null);

  // Sync external name changes
  useEffect(() => { setNameInput(projectName || ''); }, [projectName]);

  // Focus input when editing
  useEffect(() => {
    if (editingName && nameInputRef.current) nameInputRef.current.focus();
  }, [editingName]);

  // Close picker on outside click
  useEffect(() => {
    const handleClick = (e) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target)) setShowModelPicker(false);
      if (projectRef.current && !projectRef.current.contains(e.target)) setShowProjectMenu(false);
    };
    if (showModelPicker || showProjectMenu) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showModelPicker, showProjectMenu]);

  const handleNameSubmit = () => {
    setEditingName(false);
    if (nameInput.trim() && nameInput.trim() !== projectName) {
      onProjectSave(nameInput.trim());
    }
  };

  return (
    <header className="header">
      <div className="header-brand">
        <span className="header-logo">🤖</span>
        <h1 className="header-title">mBot Studio</h1>
      </div>

      {/* Project Name & Management */}
      <div className="project-controls" ref={projectRef}>
        {editingName ? (
          <input
            ref={nameInputRef}
            className="project-name-input"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onBlur={handleNameSubmit}
            onKeyDown={(e) => { if (e.key === 'Enter') handleNameSubmit(); if (e.key === 'Escape') setEditingName(false); }}
            placeholder="Project name..."
            maxLength={40}
          />
        ) : (
          <button className="project-name-btn" onClick={() => setEditingName(true)} title="Click to rename">
            📁 {projectName || 'Untitled Project'}
          </button>
        )}

        <div className="project-actions">
          <button className="project-action-btn" onClick={() => onProjectSave()} title="Save project">
            💾
          </button>
          <button className="project-action-btn" onClick={() => setShowProjectMenu(!showProjectMenu)} title="Project menu">
            📂
          </button>
          <button className="project-action-btn" onClick={onProjectNew} title="New project">
            ✨
          </button>
        </div>

        {showProjectMenu && (
          <div className="project-dropdown">
            <div className="project-dropdown-header">Saved Projects</div>
            {savedProjects && savedProjects.length > 0 ? (
              savedProjects.map((proj) => (
                <button
                  key={proj.id}
                  className={`project-option ${proj.name === projectName ? 'project-option-active' : ''}`}
                  onClick={() => { onProjectLoad(proj.id); setShowProjectMenu(false); }}
                >
                  <span className="project-option-name">{proj.name}</span>
                  <span className="project-option-meta">
                    {proj.blockCount} block{proj.blockCount !== 1 ? 's' : ''} · {proj.date}
                  </span>
                </button>
              ))
            ) : (
              <div className="project-dropdown-empty">No saved projects yet. Click 💾 to save!</div>
            )}
          </div>
        )}
      </div>

      <nav className="header-tabs">
        <button
          className={`tab ${activeTab === 'program' ? 'tab-active' : ''}`}
          onClick={() => onTabChange('program')}
        >
          🧩 Program
        </button>
        <button
          className={`tab ${activeTab === 'live' ? 'tab-active' : ''}`}
          onClick={() => onTabChange('live')}
        >
          🎮 Live Control
        </button>
        <button
          className={`tab ${activeTab === 'challenges' ? 'tab-active' : ''}`}
          onClick={() => onTabChange('challenges')}
        >
          🎯 Challenges
        </button>
        <button
          className={`tab ${activeTab === 'achievements' ? 'tab-active' : ''}`}
          onClick={() => onTabChange('achievements')}
        >
          🏆 <span className="achievement-badge-count">{achievementCount || 0}</span>
        </button>
        <button
          className={`tab ${activeTab === 'config' ? 'tab-active' : ''}`}
          onClick={() => onTabChange('config')}
        >
          ⚙️ Setup
        </button>
      </nav>

      <div className="header-right">
        <button
          className="sound-toggle-btn"
          onClick={onSoundToggle}
          title={soundMuted ? 'Unmute sounds' : 'Mute sounds'}
        >
          {soundMuted ? '🔇' : '🔊'}
        </button>

        <div className="model-selector" ref={pickerRef}>
          <button
            className="model-selector-btn"
            onClick={() => setShowModelPicker(!showModelPicker)}
            title="Change AI model"
          >
            🧠 {models.find(m => m.id === currentModel)?.name || currentModel || '...'}
            <span className="model-chevron">{showModelPicker ? '▲' : '▼'}</span>
          </button>

          {showModelPicker && (
            <div className="model-dropdown">
              <div className="model-dropdown-header">AI Model</div>
              {modelsLoading ? (
                <div className="model-dropdown-loading">Loading models...</div>
              ) : (
                models.map(m => (
                  <button
                    key={m.id}
                    className={`model-option ${m.id === currentModel ? 'model-option-active' : ''}`}
                    onClick={() => { onModelChange(m.id); setShowModelPicker(false); }}
                  >
                    <span className="model-option-name">{m.name}</span>
                    <span className="model-option-meta">
                      <span className="model-option-publisher">{m.publisher}</span>
                      {m.tier && <span className={`model-tier model-tier-${m.tier}`}>{m.tier}</span>}
                    </span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>

        <div className="header-status">
          <span className={`status-dot ${
            robotStatus?.robotOnline ? 'connected' :
            robotStatus?.mqttConnected ? 'waiting' : 'disconnected'
          }`} />
          <span className="status-text">
            {robotStatus?.robotOnline ? 'Robot Online' :
             robotStatus?.mqttConnected ? 'Waiting for Robot' : 'Robot Offline'}
          </span>
        </div>
      </div>
    </header>
  );
}

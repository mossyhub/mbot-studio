import React, { useState, useEffect, useRef } from 'react';
import './Header.css';

export default function Header({
  activeTab, onTabChange, robotConnected, robotStatus,
  currentModel,
  projectName, onProjectSave, onProjectLoad, onProjectNew, savedProjects,
  profiles, currentProfileId, onProfileSwitch, onProfileCreate, onProfileRename,
  achievementCount, achievementTotal, soundMuted, onSoundToggle,
}) {
  const [showProjectMenu, setShowProjectMenu] = useState(false);
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const [newProfileName, setNewProfileName] = useState('');
  const [renameProfileName, setRenameProfileName] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState(projectName || '');
  const [showDebugTab, setShowDebugTab] = useState(false);
  const debugClickCount = useRef(0);
  const debugClickTimer = useRef(null);
  const projectRef = useRef(null);
  const profileRef = useRef(null);
  const nameInputRef = useRef(null);

  // Sync external name changes
  useEffect(() => { setNameInput(projectName || ''); }, [projectName]);

  // Initialize profile rename input when menu opens
  useEffect(() => {
    if (showProfileMenu) {
      const activeProfile = profiles?.find(p => p.id === currentProfileId);
      setRenameProfileName(activeProfile?.name || '');
    }
  }, [showProfileMenu, profiles, currentProfileId]);

  // Focus input when editing
  useEffect(() => {
    if (editingName && nameInputRef.current) nameInputRef.current.focus();
  }, [editingName]);

  // Close picker on outside click
  useEffect(() => {
    const handleClick = (e) => {
      if (projectRef.current && !projectRef.current.contains(e.target)) setShowProjectMenu(false);
      if (profileRef.current && !profileRef.current.contains(e.target)) setShowProfileMenu(false);
    };
    if (showProjectMenu || showProfileMenu) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showProjectMenu, showProfileMenu]);

  const handleNameSubmit = () => {
    setEditingName(false);
    if (nameInput.trim() && nameInput.trim() !== projectName) {
      onProjectSave(nameInput.trim());
    }
  };

  const activeProfile = profiles?.find(p => p.id === currentProfileId);

  const handleCreateProfile = () => {
    const ok = onProfileCreate?.(newProfileName);
    if (ok) {
      setNewProfileName('');
      setShowProfileMenu(false);
    }
  };

  const handleRenameProfile = () => {
    const ok = onProfileRename?.(renameProfileName);
    if (ok) {
      setShowProfileMenu(false);
    }
  };

  return (
    <header className="header">
      <div className="header-brand">
        <span className="header-logo" onClick={() => {
          debugClickCount.current++;
          if (debugClickTimer.current) clearTimeout(debugClickTimer.current);
          debugClickTimer.current = setTimeout(() => { debugClickCount.current = 0; }, 600);
          if (debugClickCount.current >= 5) {
            setShowDebugTab(prev => !prev);
            debugClickCount.current = 0;
          }
        }}>🤖</span>
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

      {/* Child Profile Switcher */}
      <div className="profile-controls" ref={profileRef}>
        <button className="profile-btn" onClick={() => setShowProfileMenu(!showProfileMenu)} title="Switch child profile">
          👧 {activeProfile?.name || 'Kid 1'}
        </button>

        {showProfileMenu && (
          <div className="profile-dropdown">
            <div className="profile-dropdown-header">Child Profiles</div>
            {(profiles || []).map((profile) => (
              <button
                key={profile.id}
                className={`profile-option ${profile.id === currentProfileId ? 'profile-option-active' : ''}`}
                onClick={() => { onProfileSwitch?.(profile.id); setShowProfileMenu(false); }}
              >
                {profile.name}
              </button>
            ))}

            <div className="profile-create-row">
              <input
                className="profile-create-input"
                value={renameProfileName}
                onChange={(e) => setRenameProfileName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleRenameProfile(); }}
                placeholder="Rename current profile"
                maxLength={24}
              />
              <button className="profile-create-btn" onClick={handleRenameProfile} title="Rename current profile">✏️</button>
            </div>

            <div className="profile-create-row">
              <input
                className="profile-create-input"
                value={newProfileName}
                onChange={(e) => setNewProfileName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleCreateProfile(); }}
                placeholder="New child name"
                maxLength={24}
              />
              <button className="profile-create-btn" onClick={handleCreateProfile} title="Add child profile">➕</button>
            </div>
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
        {showDebugTab && (
          <button
            className={`tab ${activeTab === 'debug' ? 'tab-active' : ''}`}
            onClick={() => onTabChange('debug')}
          >
            🔧 Debug
          </button>
        )}
      </nav>

      <div className="header-right">
        <button
          className="sound-toggle-btn"
          onClick={onSoundToggle}
          title={soundMuted ? 'Unmute sounds' : 'Mute sounds'}
        >
          {soundMuted ? '🔇' : '🔊'}
        </button>

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

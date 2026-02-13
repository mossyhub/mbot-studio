import React, { useState, useCallback, useEffect, useRef } from 'react';
import Header from './components/Header.jsx';
import ChatPanel from './components/ChatPanel.jsx';
import BlocklyEditor from './components/BlocklyEditor.jsx';
import CodePreview from './components/CodePreview.jsx';
import RobotConfig from './components/RobotConfig.jsx';
import LiveControl from './components/LiveControl.jsx';
import StatusBar from './components/StatusBar.jsx';
import Celebrations from './components/Celebrations.jsx';
import Achievements from './components/Achievements.jsx';
import Challenges from './components/Challenges.jsx';
import TemplateGallery from './components/TemplateGallery.jsx';
import { playProgramSent, playSuccess, playError, playStop, playConnect, playDisconnect, playClick, playAchievement, playCelebration, isMuted, setMuted } from './services/sound-service';
import { checkProgramAchievements, tryEarnBadge, incrementStat, getProgress, setAchievementsProfile } from './services/achievements';
import './App.css';

const TABS = {
  PROGRAM: 'program',
  LIVE: 'live',
  CHALLENGES: 'challenges',
  ACHIEVEMENTS: 'achievements',
  CONFIG: 'config',
};

const PROFILES_KEY = 'mbot-studio-profiles';
const CURRENT_PROFILE_KEY = 'mbot-studio-current-profile';

const DEFAULT_WELCOME = {
  role: 'assistant',
  content: "Hi there! 👋 I'm your robot helper! Tell me what you want your mBot2 to do, and I'll help you program it!\n\nTry saying something like:\n• \"Go forward for 3 seconds\"\n• \"Explore the room and avoid obstacles\"\n• \"Do a dance!\"",
};

function getProjectStorageKey(profileId) {
  return `mbot-studio-projects:${profileId || 'default'}`;
}

function getCurrentProjectStorageKey(profileId) {
  return `mbot-studio-current-project:${profileId || 'default'}`;
}

function loadProfiles() {
  try {
    const profiles = JSON.parse(localStorage.getItem(PROFILES_KEY) || '[]');
    if (Array.isArray(profiles) && profiles.length > 0) return profiles;
  } catch { }
  return [{ id: 'profile_default', name: 'Kid 1', createdAt: new Date().toISOString() }];
}

function saveProfilesToStorage(profiles) {
  localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
}

function loadCurrentProfileId() {
  return localStorage.getItem(CURRENT_PROFILE_KEY) || null;
}

function saveCurrentProfileId(id) {
  if (id) localStorage.setItem(CURRENT_PROFILE_KEY, id);
  else localStorage.removeItem(CURRENT_PROFILE_KEY);
}

function loadProjects(profileId) {
  try {
    return JSON.parse(localStorage.getItem(getProjectStorageKey(profileId)) || '[]');
  } catch { return []; }
}

function saveProjectsToStorage(profileId, projects) {
  localStorage.setItem(getProjectStorageKey(profileId), JSON.stringify(projects));
}

function loadCurrentProjectId(profileId) {
  return localStorage.getItem(getCurrentProjectStorageKey(profileId)) || null;
}

function saveCurrentProjectId(profileId, id) {
  const key = getCurrentProjectStorageKey(profileId);
  if (id) localStorage.setItem(key, id);
  else localStorage.removeItem(key);
}

export default function App() {
  const [activeTab, setActiveTab] = useState(TABS.PROGRAM);
  const [blocks, setBlocks] = useState([]);
  const [pythonCode, setPythonCode] = useState('');
  const [showCode, setShowCode] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [robotConfig, setRobotConfig] = useState(null);
  const [robotStatus, setRobotStatus] = useState({ connected: false, mqttConnected: false, robotOnline: false, robotState: 'unknown' });
  const [currentModel, setCurrentModel] = useState('');
  const [projectName, setProjectName] = useState('Untitled Project');
  const [projectId, setProjectId] = useState(null);
  const [savedProjects, setSavedProjects] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [currentProfileId, setCurrentProfileId] = useState(null);
  const [messages, setMessages] = useState([DEFAULT_WELCOME]);
  const [blockHistory, setBlockHistory] = useState([[]]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [pendingSuggestion, setPendingSuggestion] = useState(null);
  const [applyMode, setApplyMode] = useState('replace');
  const [celebrationQueue, setCelebrationQueue] = useState([]);
  const [soundMuted, setSoundMuted] = useState(isMuted());
  const prevRobotOnline = useRef(false);

  const commitBlocks = useCallback((newBlocks) => {
    setBlocks(newBlocks);
    setBlockHistory(prev => {
      const base = prev.slice(0, historyIndex + 1);
      return [...base, newBlocks];
    });
    setHistoryIndex(prev => prev + 1);
  }, [historyIndex]);

  const resetBlockHistory = useCallback((initialBlocks) => {
    setBlockHistory([initialBlocks]);
    setHistoryIndex(0);
  }, []);

  // Load profiles on startup
  useEffect(() => {
    const loadedProfiles = loadProfiles();
    setProfiles(loadedProfiles);

    const savedProfileId = loadCurrentProfileId();
    const validProfile = loadedProfiles.find(p => p.id === savedProfileId) || loadedProfiles[0];
    if (validProfile) {
      setCurrentProfileId(validProfile.id);
      saveCurrentProfileId(validProfile.id);
    }
  }, []);

  // Load projects for active profile
  useEffect(() => {
    if (!currentProfileId) return;

    setAchievementsProfile(currentProfileId);

    const projects = loadProjects(currentProfileId);
    setSavedProjects(projects.map(p => ({
      id: p.id,
      name: p.name,
      blockCount: p.blocks?.length || 0,
      date: new Date(p.savedAt).toLocaleDateString(),
    })));

    const lastId = loadCurrentProjectId(currentProfileId);
    if (lastId) {
      const proj = projects.find(p => p.id === lastId);
      if (proj) {
        setProjectId(proj.id);
        setProjectName(proj.name);
        setBlocks(proj.blocks || []);
        resetBlockHistory(proj.blocks || []);
        setPythonCode(proj.pythonCode || '');
        setMessages(proj.messages && proj.messages.length > 0 ? proj.messages : [DEFAULT_WELCOME]);
        return;
      }
    }

    setProjectId(null);
    setProjectName('Untitled Project');
    setBlocks([]);
    resetBlockHistory([]);
    setPythonCode('');
    setMessages([DEFAULT_WELCOME]);
    setPendingSuggestion(null);
    saveCurrentProjectId(currentProfileId, null);
  }, [currentProfileId, resetBlockHistory]);

  // Load robot config and active AI model on startup
  useEffect(() => {
    fetch('/api/config')
      .then(r => r.json())
      .then(setRobotConfig)
      .catch(console.error);

    // Fetch active AI model selected by server startup logic
    fetch('/api/ai/model')
      .then(r => r.json())
      .then(data => setCurrentModel(data.model || ''))
      .catch(console.error);

    // Check robot status periodically
    const checkStatus = () => {
      fetch('/api/robot/status')
        .then(r => r.json())
        .then(s => setRobotStatus({
          connected: s.robotOnline,        // true only when robot is actually responding
          mqttConnected: s.mqttConnected,   // broker connection
          robotOnline: s.robotOnline,       // robot heartbeat received recently
          robotState: s.robotState || 'unknown',
          robotLastSeen: s.robotLastSeen,
        }))
        .catch(() => setRobotStatus({ connected: false, mqttConnected: false, robotOnline: false, robotState: 'unknown' }));
    };
    checkStatus();
    const interval = setInterval(checkStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  // Sound feedback for robot connection changes
  useEffect(() => {
    if (robotStatus.robotOnline && !prevRobotOnline.current) {
      playConnect();
    } else if (!robotStatus.robotOnline && prevRobotOnline.current) {
      playDisconnect();
    }
    prevRobotOnline.current = robotStatus.robotOnline;
  }, [robotStatus.robotOnline]);

  const handleAIResponse = useCallback((response) => {
    if (response.program) {
      setPendingSuggestion({
        program: response.program,
        explanation: response.explanation || '',
      });
      if (response.pythonCode) {
        setPythonCode(response.pythonCode);
      }
    }
    // First chat achievement
    const b = tryEarnBadge('first_chat');
    if (b) setCelebrationQueue(prev => [...prev, { badge: b, type: 'confetti' }]);
  }, []);

  const handleBlocksChange = useCallback((newBlocks) => {
    commitBlocks(newBlocks);
    setPendingSuggestion(null);
    // Regenerate Python code when blocks change
    fetch('/api/ai/blocks-to-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocks: newBlocks }),
    })
      .then(r => r.json())
      .then(data => setPythonCode(data.code))
      .catch(console.error);
  }, [commitBlocks]);

  const handleApplySuggestion = useCallback(() => {
    if (!pendingSuggestion?.program) return;
    const merged = applyMode === 'append'
      ? [...blocks, ...pendingSuggestion.program]
      : pendingSuggestion.program;
    commitBlocks(merged);
    setPendingSuggestion(null);
    fetch('/api/ai/blocks-to-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocks: merged }),
    })
      .then(r => r.json())
      .then(data => setPythonCode(data.code))
      .catch(console.error);
  }, [pendingSuggestion, applyMode, blocks, commitBlocks]);

  const handleDiscardSuggestion = useCallback(() => {
    setPendingSuggestion(null);
  }, []);

  const handleUndo = useCallback(() => {
    if (historyIndex <= 0) return;
    const nextIndex = historyIndex - 1;
    const prevBlocks = blockHistory[nextIndex] || [];
    setHistoryIndex(nextIndex);
    setBlocks(prevBlocks);
    setPendingSuggestion(null);
    fetch('/api/ai/blocks-to-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocks: prevBlocks }),
    })
      .then(r => r.json())
      .then(data => setPythonCode(data.code))
      .catch(console.error);
  }, [historyIndex, blockHistory]);

  const handleRedo = useCallback(() => {
    if (historyIndex >= blockHistory.length - 1) return;
    const nextIndex = historyIndex + 1;
    const nextBlocks = blockHistory[nextIndex] || [];
    setHistoryIndex(nextIndex);
    setBlocks(nextBlocks);
    setPendingSuggestion(null);
    fetch('/api/ai/blocks-to-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocks: nextBlocks }),
    })
      .then(r => r.json())
      .then(data => setPythonCode(data.code))
      .catch(console.error);
  }, [historyIndex, blockHistory]);

  const handleRunProgram = useCallback(async () => {
    if (blocks.length === 0) return;

    // Check achievements before running
    const newBadges = checkProgramAchievements(blocks);

    try {
      playProgramSent();
      const res = await fetch('/api/robot/program', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ program: blocks }),
      });
      const data = await res.json();
      if (data.error) {
        playError();
        alert('Could not send to robot: ' + data.error + '\n' + (data.hint || ''));
      } else {
        // Trigger celebrations for achievements earned
        if (newBadges.length > 0) {
          const celebrations = newBadges.map(badge => ({ badge, type: 'confetti' }));
          setCelebrationQueue(prev => [...prev, ...celebrations]);
          newBadges.forEach(() => playAchievement());
        }
      }
    } catch (err) {
      playError();
      alert('Error sending program: ' + err.message);
    }
  }, [blocks]);

  const handleStop = useCallback(async () => {
    playStop();
    try {
      await fetch('/api/robot/stop', { method: 'POST' });
    } catch (err) {
      console.error('Stop error:', err);
    }
  }, []);

  const handleConfigUpdate = useCallback((config) => {
    setRobotConfig(config);
    // Check for config-related achievements
    if (config?.additions?.length > 0) {
      const b = tryEarnBadge('custom_hardware');
      if (b) setCelebrationQueue(prev => [...prev, { badge: b, type: 'confetti' }]);
    }
  }, []);

  // === Project Management ===
  const handleProjectSave = useCallback((newName) => {
    if (!currentProfileId) return;
    playClick();
    const name = newName || projectName || 'Untitled Project';
    const id = projectId || `proj_${Date.now()}`;
    const project = {
      id,
      name,
      blocks,
      pythonCode,
      messages,
      savedAt: new Date().toISOString(),
    };

    const projects = loadProjects(currentProfileId);
    const existingIdx = projects.findIndex(p => p.id === id);
    if (existingIdx >= 0) {
      projects[existingIdx] = project;
    } else {
      projects.unshift(project);
    }
    saveProjectsToStorage(currentProfileId, projects);
    saveCurrentProjectId(currentProfileId, id);

    setProjectId(id);
    setProjectName(name);
    setSavedProjects(projects.map(p => ({
      id: p.id,
      name: p.name,
      blockCount: p.blocks?.length || 0,
      date: new Date(p.savedAt).toLocaleDateString(),
    })));

    // Achievement for first save
    const b = tryEarnBadge('first_save');
    if (b) setCelebrationQueue(prev => [...prev, { badge: b, type: 'confetti' }]);
  }, [currentProfileId, projectId, projectName, blocks, pythonCode, messages]);

  const handleProjectLoad = useCallback((id) => {
    if (!currentProfileId) return;
    const projects = loadProjects(currentProfileId);
    const proj = projects.find(p => p.id === id);
    if (!proj) return;

    setProjectId(proj.id);
    setProjectName(proj.name);
    setBlocks(proj.blocks || []);
    resetBlockHistory(proj.blocks || []);
    setPythonCode(proj.pythonCode || '');
    setMessages(proj.messages && proj.messages.length > 0 ? proj.messages : [DEFAULT_WELCOME]);
    setPendingSuggestion(null);
    saveCurrentProjectId(currentProfileId, proj.id);
  }, [currentProfileId, resetBlockHistory]);

  const handleProjectNew = useCallback(() => {
    if (!currentProfileId) return;
    setProjectId(null);
    setProjectName('Untitled Project');
    setBlocks([]);
    resetBlockHistory([]);
    setPythonCode('');
    setMessages([DEFAULT_WELCOME]);
    setPendingSuggestion(null);
    saveCurrentProjectId(currentProfileId, null);
  }, [currentProfileId, resetBlockHistory]);

  const handleProfileSwitch = useCallback((profileId) => {
    setCurrentProfileId(profileId);
    saveCurrentProfileId(profileId);
  }, []);

  const handleProfileCreate = useCallback((profileName) => {
    const cleaned = (profileName || '').trim();
    if (!cleaned) return false;
    if (profiles.some(p => p.name.toLowerCase() === cleaned.toLowerCase())) return false;

    const newProfile = {
      id: `profile_${Date.now()}`,
      name: cleaned,
      createdAt: new Date().toISOString(),
    };
    const updated = [...profiles, newProfile];
    setProfiles(updated);
    saveProfilesToStorage(updated);
    setCurrentProfileId(newProfile.id);
    saveCurrentProfileId(newProfile.id);
    return true;
  }, [profiles]);

  const handleProfileRename = useCallback((profileName) => {
    const cleaned = (profileName || '').trim();
    if (!cleaned || !currentProfileId) return false;

    if (profiles.some(p => p.id !== currentProfileId && p.name.toLowerCase() === cleaned.toLowerCase())) {
      return false;
    }

    const updated = profiles.map(profile => (
      profile.id === currentProfileId
        ? { ...profile, name: cleaned }
        : profile
    ));

    setProfiles(updated);
    saveProfilesToStorage(updated);
    return true;
  }, [profiles, currentProfileId]);

  const handleCelebrationDone = useCallback(() => {
    setCelebrationQueue(prev => prev.slice(1));
  }, []);

  const handleChallengeLoadProgram = useCallback((challenge) => {
    // Switch to program tab so they can code the challenge
    setActiveTab(TABS.PROGRAM);
    playClick();
  }, []);

  const handleChallengeCelebration = useCallback((badge) => {
    setCelebrationQueue(prev => [...prev, { badge, type: 'confetti' }]);
    playAchievement();
  }, []);

  const handleAchievement = useCallback((badgeId) => {
    const b = tryEarnBadge(badgeId);
    if (b) {
      setCelebrationQueue(prev => [...prev, { badge: b, type: 'confetti' }]);
      playAchievement();
    }
  }, []);

  const handleTemplateLoad = useCallback((templateBlocks, templateName) => {
    commitBlocks(templateBlocks);
    setPendingSuggestion(null);
    setProjectName(templateName || 'Template Program');
    // Regenerate code
    fetch('/api/ai/blocks-to-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocks: templateBlocks }),
    })
      .then(r => r.json())
      .then(data => setPythonCode(data.code))
      .catch(console.error);
    setShowTemplates(false);
    playClick();
  }, [commitBlocks]);

  const handleSoundToggle = useCallback(() => {
    const newMuted = !soundMuted;
    setSoundMuted(newMuted);
    setMuted(newMuted);
  }, [soundMuted]);

  const achievementProgress = getProgress();

  return (
    <div className="app">
      <Header
        activeTab={activeTab}
        onTabChange={(tab) => { playClick(); setActiveTab(tab); }}
        robotConnected={robotStatus.connected}
        robotStatus={robotStatus}
        currentModel={currentModel}
        projectName={projectName}
        onProjectSave={handleProjectSave}
        onProjectLoad={handleProjectLoad}
        onProjectNew={handleProjectNew}
        savedProjects={savedProjects}
        profiles={profiles}
        currentProfileId={currentProfileId}
        onProfileSwitch={handleProfileSwitch}
        onProfileCreate={handleProfileCreate}
        onProfileRename={handleProfileRename}
        achievementCount={achievementProgress.earned}
        achievementTotal={achievementProgress.total}
        soundMuted={soundMuted}
        onSoundToggle={handleSoundToggle}
      />

      <div className="app-content">
        {activeTab === TABS.PROGRAM && (
          <div className="program-layout">
            <div className="panel chat-panel-container">
              <ChatPanel
                messages={messages}
                setMessages={setMessages}
                onAIResponse={handleAIResponse}
                currentBlocks={blocks}
              />
            </div>

            <div className="panel blocks-panel-container">
              <div className="panel-header">
                <div>
                  <h2>🧩 Block Program</h2>
                  <div className="panel-subtitle">Run sends commands to the robot firmware over MQTT.</div>
                </div>
                <div className="panel-actions">
                  <button
                    className="btn-secondary btn-small"
                    onClick={handleUndo}
                    disabled={historyIndex <= 0}
                    title="Undo"
                  >
                    ↶ Undo
                  </button>
                  <button
                    className="btn-secondary btn-small"
                    onClick={handleRedo}
                    disabled={historyIndex >= blockHistory.length - 1}
                    title="Redo"
                  >
                    ↷ Redo
                  </button>
                  <button
                    className="btn-secondary btn-small"
                    onClick={() => setShowTemplates(!showTemplates)}
                    title="Program templates"
                  >
                    📚 Templates
                  </button>
                  <button
                    className="btn-secondary"
                    onClick={() => setShowCode(!showCode)}
                  >
                    {showCode ? '🧩 Show Blocks' : '🐍 Show Python'}
                  </button>
                  <button
                    className="btn-danger"
                    onClick={handleStop}
                    title="Emergency Stop"
                  >
                    🛑 STOP
                  </button>
                  <button
                    className="btn-primary"
                    onClick={handleRunProgram}
                    disabled={blocks.length === 0}
                  >
                    ▶️ Send via MQTT
                  </button>
                </div>
              </div>

              {pendingSuggestion && (
                <div className="suggestion-bar">
                  <span className="suggestion-title">✨ AI draft ready ({pendingSuggestion.program.length} blocks)</span>
                  <select
                    value={applyMode}
                    onChange={(e) => setApplyMode(e.target.value)}
                    className="suggestion-mode"
                  >
                    <option value="replace">Replace current</option>
                    <option value="append">Append to current</option>
                  </select>
                  <button className="btn-small btn-primary" onClick={handleApplySuggestion}>Apply</button>
                  <button className="btn-small btn-secondary" onClick={handleDiscardSuggestion}>Dismiss</button>
                </div>
              )}

              {showTemplates && (
                <div className="templates-section">
                  <TemplateGallery onLoadTemplate={handleTemplateLoad} robotConfig={robotConfig} />
                </div>
              )}

              {showCode ? (
                <CodePreview code={pythonCode} blocks={blocks} />
              ) : (
                <BlocklyEditor
                  blocks={blocks}
                  onBlocksChange={handleBlocksChange}
                  robotConfig={robotConfig}
                />
              )}
            </div>
          </div>
        )}

        {activeTab === TABS.LIVE && (
          <LiveControl
            robotConfig={robotConfig}
            robotConnected={robotStatus.connected}
            currentProfileId={currentProfileId}
            onStop={handleStop}
            onAchievement={handleAchievement}
          />
        )}

        {activeTab === TABS.CHALLENGES && (
          <div className="panel" style={{ height: '100%', overflow: 'hidden' }}>
            <Challenges
              currentProfileId={currentProfileId}
              onLoadProgram={handleChallengeLoadProgram}
              onCelebration={handleChallengeCelebration}
            />
          </div>
        )}

        {activeTab === TABS.ACHIEVEMENTS && (
          <div className="panel" style={{ height: '100%', overflow: 'hidden' }}>
            <Achievements currentProfileId={currentProfileId} />
          </div>
        )}

        {activeTab === TABS.CONFIG && (
          <RobotConfig
            config={robotConfig}
            onConfigUpdate={handleConfigUpdate}
            robotConnected={robotStatus.connected}
            onAchievement={handleAchievement}
          />
        )}
      </div>

      <Celebrations
        celebrationQueue={celebrationQueue}
        onCelebrationDone={handleCelebrationDone}
      />

      <StatusBar
        robotConnected={robotStatus.connected}
        robotStatus={robotStatus}
        soundMuted={soundMuted}
        onSoundToggle={handleSoundToggle}
      />
    </div>
  );
}

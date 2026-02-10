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
import { checkProgramAchievements, tryEarnBadge, incrementStat, getProgress } from './services/achievements';
import './App.css';

const TABS = {
  PROGRAM: 'program',
  LIVE: 'live',
  CHALLENGES: 'challenges',
  ACHIEVEMENTS: 'achievements',
  CONFIG: 'config',
};

const STORAGE_KEY = 'mbot-studio-projects';
const CURRENT_PROJECT_KEY = 'mbot-studio-current-project';

const DEFAULT_WELCOME = {
  role: 'assistant',
  content: "Hi there! 👋 I'm your robot helper! Tell me what you want your mBot2 to do, and I'll help you program it!\n\nTry saying something like:\n• \"Go forward for 3 seconds\"\n• \"Explore the room and avoid obstacles\"\n• \"Do a dance!\"",
};

function loadProjects() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch { return []; }
}

function saveProjectsToStorage(projects) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
}

function loadCurrentProjectId() {
  return localStorage.getItem(CURRENT_PROJECT_KEY) || null;
}

function saveCurrentProjectId(id) {
  if (id) localStorage.setItem(CURRENT_PROJECT_KEY, id);
  else localStorage.removeItem(CURRENT_PROJECT_KEY);
}

export default function App() {
  const [activeTab, setActiveTab] = useState(TABS.PROGRAM);
  const [blocks, setBlocks] = useState([]);
  const [pythonCode, setPythonCode] = useState('');
  const [showCode, setShowCode] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [robotConfig, setRobotConfig] = useState(null);
  const [robotStatus, setRobotStatus] = useState({ connected: false, mqttConnected: false, robotOnline: false, robotState: 'unknown' });
  const [aiModels, setAiModels] = useState([]);
  const [currentModel, setCurrentModel] = useState('');
  const [modelsLoading, setModelsLoading] = useState(true);
  const [projectName, setProjectName] = useState('Untitled Project');
  const [projectId, setProjectId] = useState(null);
  const [savedProjects, setSavedProjects] = useState([]);
  const [messages, setMessages] = useState([DEFAULT_WELCOME]);
  const [celebrationQueue, setCelebrationQueue] = useState([]);
  const [soundMuted, setSoundMuted] = useState(isMuted());
  const prevRobotOnline = useRef(false);

  // Load saved projects list on startup + restore last project
  useEffect(() => {
    const projects = loadProjects();
    setSavedProjects(projects.map(p => ({
      id: p.id,
      name: p.name,
      blockCount: p.blocks?.length || 0,
      date: new Date(p.savedAt).toLocaleDateString(),
    })));

    const lastId = loadCurrentProjectId();
    if (lastId) {
      const proj = projects.find(p => p.id === lastId);
      if (proj) {
        setProjectId(proj.id);
        setProjectName(proj.name);
        setBlocks(proj.blocks || []);
        setPythonCode(proj.pythonCode || '');
        setMessages(proj.messages && proj.messages.length > 0 ? proj.messages : [DEFAULT_WELCOME]);
      }
    }
  }, []);

  // Load robot config and available AI models on startup
  useEffect(() => {
    fetch('/api/config')
      .then(r => r.json())
      .then(setRobotConfig)
      .catch(console.error);

    // Fetch available AI models
    fetch('/api/ai/models')
      .then(r => r.json())
      .then(data => {
        setAiModels(data.models || []);
        setCurrentModel(data.current || '');
        setModelsLoading(false);
      })
      .catch(() => setModelsLoading(false));

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
      setBlocks(response.program);
      if (response.pythonCode) {
        setPythonCode(response.pythonCode);
      }
    }
    // First chat achievement
    const b = tryEarnBadge('first_chat');
    if (b) setCelebrationQueue(prev => [...prev, { badge: b, type: 'confetti' }]);
  }, []);

  const handleBlocksChange = useCallback((newBlocks) => {
    setBlocks(newBlocks);
    // Regenerate Python code when blocks change
    fetch('/api/ai/blocks-to-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocks: newBlocks }),
    })
      .then(r => r.json())
      .then(data => setPythonCode(data.code))
      .catch(console.error);
  }, []);

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

  const handleModelChange = useCallback(async (modelId) => {
    try {
      const res = await fetch('/api/ai/model', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelId }),
      });
      const data = await res.json();
      if (data.success) {
        setCurrentModel(data.model);
      }
    } catch (err) {
      console.error('Model switch error:', err);
    }
  }, []);

  // === Project Management ===
  const handleProjectSave = useCallback((newName) => {
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

    const projects = loadProjects();
    const existingIdx = projects.findIndex(p => p.id === id);
    if (existingIdx >= 0) {
      projects[existingIdx] = project;
    } else {
      projects.unshift(project);
    }
    saveProjectsToStorage(projects);
    saveCurrentProjectId(id);

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
  }, [projectId, projectName, blocks, pythonCode, messages]);

  const handleProjectLoad = useCallback((id) => {
    const projects = loadProjects();
    const proj = projects.find(p => p.id === id);
    if (!proj) return;

    setProjectId(proj.id);
    setProjectName(proj.name);
    setBlocks(proj.blocks || []);
    setPythonCode(proj.pythonCode || '');
    setMessages(proj.messages && proj.messages.length > 0 ? proj.messages : [DEFAULT_WELCOME]);
    saveCurrentProjectId(proj.id);
  }, []);

  const handleProjectNew = useCallback(() => {
    setProjectId(null);
    setProjectName('Untitled Project');
    setBlocks([]);
    setPythonCode('');
    setMessages([DEFAULT_WELCOME]);
    saveCurrentProjectId(null);
  }, []);

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
    setBlocks(templateBlocks);
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
  }, []);

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
        models={aiModels}
        currentModel={currentModel}
        onModelChange={handleModelChange}
        modelsLoading={modelsLoading}
        projectName={projectName}
        onProjectSave={handleProjectSave}
        onProjectLoad={handleProjectLoad}
        onProjectNew={handleProjectNew}
        savedProjects={savedProjects}
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
                <h2>🧩 Block Program</h2>
                <div className="panel-actions">
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
                    ▶️ Run on Robot
                  </button>
                </div>
              </div>

              {showTemplates && (
                <div className="templates-section">
                  <TemplateGallery onLoadTemplate={handleTemplateLoad} />
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
            onStop={handleStop}
            onAchievement={handleAchievement}
          />
        )}

        {activeTab === TABS.CHALLENGES && (
          <div className="panel" style={{ height: '100%', overflow: 'hidden' }}>
            <Challenges
              onLoadProgram={handleChallengeLoadProgram}
              onCelebration={handleChallengeCelebration}
            />
          </div>
        )}

        {activeTab === TABS.ACHIEVEMENTS && (
          <div className="panel" style={{ height: '100%', overflow: 'hidden' }}>
            <Achievements />
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

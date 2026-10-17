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
import Challenges, { MissionStrip } from './components/Challenges.jsx';
import { captureSubmission, acceptSubmission, completeSubmission, cancelSubmission } from './services/challenge-progress.js';
import { programEvidenceProfile, readProgramEvidence, agreesWithServer } from './services/program-evidence.js';
import TemplateGallery from './components/TemplateGallery.jsx';
import DebugTerminal from './components/DebugTerminal.jsx';
import { playProgramSent, playSuccess, playError, playStop, playConnect, playDisconnect, playClick, playAchievement, playCelebration, isMuted, setMuted } from './services/sound-service';
import { tryEarnBadge, getProgress, setAchievementsProfile } from './services/achievements';
import './App.css';
import RobotDiagnostics from './components/RobotDiagnostics.jsx';
import StudioIcon from './components/StudioIcon.jsx';
import './GuidedTheme.css';

const TABS = {
  PROGRAM: 'program',
  LIVE: 'live',
  CHALLENGES: 'challenges',
  ACHIEVEMENTS: 'achievements',
  CONFIG: 'config',
  DEBUG: 'debug',
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
  const [disconnectedCount, setDisconnectedCount] = useState(0);
  const [preview, setPreview] = useState(null);
  const restoredPreview = useRef(null);
  const pythonCode = preview?.blocks === blocks && preview.status === 'ready' ? preview.code : '';
  const restoreBlocks = useCallback((loadedBlocks, code = '') => {
    const restored = { blocks: loadedBlocks, code: typeof code === 'string' ? code : '', status: 'ready' };
    restoredPreview.current = restored;
    setBlocks(loadedBlocks);
    setPreview(restored);
  }, []);
  useEffect(() => {
    // Saved source belongs to these exact loaded blocks; editing invalidates it.
    if (restoredPreview.current?.blocks === blocks) return;
    restoredPreview.current = null;
    if (!blocks.length) { setPreview({ blocks, code: '', status: 'ready' }); return; }
    const controller = new AbortController();
    let current = true;
    setPreview({ blocks, code: '', status: 'pending' });
    fetch('/api/ai/blocks-to-code', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocks }), signal: controller.signal,
    }).then(response => response.json().then(data => ({ response, data })))
      .then(({ response, data }) => {
        if (!response.ok || data?.error || typeof data?.code !== 'string') {
          throw new Error(data?.error || (!response.ok ? `HTTP ${response.status}` : 'Generator returned no Python code.'));
        }
        if (current) setPreview({ blocks, code: data.code, status: 'ready' });
      }).catch(error => {
        if (current) setPreview({ blocks, code: '', status: 'error',
          error: `Python generation failed: ${error.message || 'Server unavailable.'}` });
      });
    return () => { current = false; controller.abort(); };
  }, [blocks]);
  const [showCode, setShowCode] = useState(false);
  const [showHelper, setShowHelper] = useState(false);
  const helperGeneration = useRef(0);
  const [helperEpoch, setHelperEpoch] = useState(0);
  const helperOpener = useRef(null);
  const helperCloseButton = useRef(null);
  const openHelper = event => {
    helperOpener.current = event.currentTarget;
    setShowHelper(true);
  };
  const closeHelper = useCallback(() => {
    setShowHelper(false);
    helperOpener.current?.focus();
  }, []);
  useEffect(() => {
    if (!showHelper) return;
    helperCloseButton.current?.focus();
    const escape = event => { if (event.key === 'Escape') closeHelper(); };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [showHelper, closeHelper]);
  const [programCheck, setProgramCheck] = useState(null);
  const [showTemplates, setShowTemplates] = useState(false);
  const [robotConfig, setRobotConfig] = useState(null);
  const [robotStatus, setRobotStatus] = useState({ connected: false, mqttConnected: false, robotOnline: false, robotState: 'unknown' });
  const [currentModel, setCurrentModel] = useState('');
  const [projectName, setProjectName] = useState('Untitled Project');
  const [projectId, setProjectId] = useState(null);
  const [savedProjects, setSavedProjects] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [currentProfileId, setCurrentProfileId] = useState(null);
  const currentProfileRef = useRef(currentProfileId);
  currentProfileRef.current = currentProfileId;
  const [activeMission, setActiveMission] = useState(null);
  const [guidanceOpen, setGuidanceOpen] = useState(() => window.matchMedia('(min-width: 601px)').matches);
  useEffect(() => {
    const query = window.matchMedia('(min-width: 601px)');
    const update = () => setGuidanceOpen(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  const [progressVersion, setProgressVersion] = useState(0);
  const [messages, setMessages] = useState([DEFAULT_WELCOME]);
  const [blockHistory, setBlockHistory] = useState([[]]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [pendingSuggestion, setPendingSuggestion] = useState(null);
  const [applyMode, setApplyMode] = useState('replace');
  const [celebrationQueue, setCelebrationQueue] = useState([]);
  const [soundMuted, setSoundMuted] = useState(isMuted());
  const [errorToast, setErrorToast] = useState(null);
  const prevRobotOnline = useRef(false);
  const activeRun = useRef(null);
  const [programLifecycle, setProgramLifecycle] = useState(null);
  const cancelActiveRun = useCallback((text) => {
    const run = activeRun.current;
    // Invalidate first: abort/close may resume an older async continuation.
    activeRun.current = null;
    if (!run) return;
    cancelSubmission(run.submission);
    run.dispose();
    setProgramLifecycle({ text, pending: false });
  }, []);
  useEffect(() => () => {
    const run = activeRun.current;
    activeRun.current = null;
    cancelSubmission(run?.submission);
    run?.dispose();
  }, []);

  const checkRuntime = robotStatus.build === 'mbot-av-control-v1';
  // Heartbeat timestamps are deliberately excluded: typing triggers a read-only
  // check, not one request per heartbeat. Admission is repeated by Run on server.
  const checkIdentity = JSON.stringify([robotStatus.build, robotStatus.boot, robotStatus.robotOnline,
    robotStatus.mqttConnected, robotStatus.armed, robotStatus.motion_enabled, robotStatus.capabilities]);
  useEffect(() => {
    if (!checkRuntime || !blocks.length) { setProgramCheck(null); return; }
    const controller = new AbortController();
    let current = true;
    setProgramCheck({ blocks, identity: checkIdentity, checking: true, runnable: false });
    const timer = setTimeout(async () => {
      try {
        const response = await fetch('/api/robot/program/validate', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ program: blocks }), signal: controller.signal,
        });
        const result = await response.json();
        if (current) setProgramCheck({ ...result, blocks, identity: checkIdentity,
          checking: false, runnable: response.ok && result.runnable === true,
          error: result.error || (!response.ok ? `Validation HTTP ${response.status}` : undefined) });
      } catch (error) {
        if (current) setProgramCheck({ blocks, identity: checkIdentity, checking: false,
          runnable: false, error: 'Cannot check this program — server unavailable.' });
      }
    }, 250);
    return () => { current = false; clearTimeout(timer); controller.abort(); };
  }, [blocks, checkRuntime, checkIdentity]);
  const checkIsCurrent = programCheck?.blocks === blocks && programCheck?.identity === checkIdentity;
  const programBlocked = checkRuntime && (!robotStatus.robotOnline || !checkIsCurrent || !programCheck?.runnable);
  const programEncoding = checkIsCurrent && programCheck?.runnable && robotStatus.robotOnline
    && robotStatus.mqttConnected && robotStatus.capabilities?.includes('program_indexed_v1')
    && programCheck.encoding === 'indexed-v1' ? 'indexed-v1' : 'flat';
  const knownLimits = programEvidenceProfile(programEncoding);
  // Preflight may tighten a known profile, never enlarge it with arbitrary values.
  const limit = key => Number.isFinite(programCheck?.limits?.[key]) && programCheck.limits[key] > 0
    ? Math.min(programCheck.limits[key], knownLimits[key]) : knownLimits[key];
  const readinessSummary = `Ready to run · ${programCheck?.expandedCount ?? programCheck?.compiledCount ?? '?'} / ${limit('instructions')} ${programEncoding === 'indexed-v1' ? 'executed steps' : 'robot steps'}`
    + (programEncoding === 'indexed-v1' ? ` · ${programCheck.uniqueCommandCount ?? '?'} / ${limit('uniqueCommands')} distinct commands` : '')
    + (Number.isFinite(programCheck?.wireBytes) ? ` · ${programCheck.wireBytes} / ${limit('wireBytes')} wire bytes` : '')
    + (Number.isFinite(programCheck?.requestedHoldSeconds) ? ` · ${Number(programCheck.requestedHoldSeconds.toFixed(3))} / ${limit('requestedHoldSeconds')} s requested holds` : '');

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
    cancelSubmission(activeRun.current?.submission);
    setActiveMission(null);
    setCelebrationQueue([]);

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
        const loadedBlocks = proj.blocks || [];
        restoreBlocks(loadedBlocks, proj.pythonCode);
        resetBlockHistory(loadedBlocks);
        setPendingSuggestion(null);
        setMessages(proj.messages && proj.messages.length > 0 ? proj.messages : [DEFAULT_WELCOME]);
        return;
      }
    }

    setProjectId(null);
    setProjectName('Untitled Project');
    const emptyBlocks = [];
    restoreBlocks(emptyBlocks);
    resetBlockHistory(emptyBlocks);
    setMessages([DEFAULT_WELCOME]);
    setPendingSuggestion(null);
    saveCurrentProjectId(currentProfileId, null);
  }, [currentProfileId, resetBlockHistory, restoreBlocks]);

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

    // Only the newest poll may publish status, even if abort loses a race
    // with response-body delivery. Cleanup also revokes the final poll.
    let statusGeneration = 0;
    let statusAbort;
    let statusDeadline;
    const unavailable = () => setRobotStatus({ connected: false, mqttConnected: false, robotOnline: false, robotState: 'unknown' });
    const checkStatus = () => {
      const token = ++statusGeneration;
      clearTimeout(statusDeadline);
      statusAbort?.abort();
      const controller = new AbortController();
      statusAbort = controller;
      // Expire before the next five-second poll; an abort alone cannot fence
      // a body already delivered to JavaScript.
      statusDeadline = setTimeout(() => {
        if (token !== statusGeneration) return;
        statusGeneration++;
        controller.abort();
        unavailable();
      }, 4500);
      fetch('/api/robot/status', { signal: controller.signal, cache: 'no-store' })
        .then(r => { if (!r.ok) throw new Error(`Status HTTP ${r.status}`); return r.json(); })
        .then(s => { if (token === statusGeneration) setRobotStatus({
          connected: s.robotOnline,        // true only when robot is actually responding
          mqttConnected: s.mqttConnected,   // broker connection
          robotOnline: s.robotOnline,       // robot heartbeat received recently
          robotState: s.robotState || 'unknown',
          robotLastSeen: s.robotLastSeen,
          application: s.application,
          motion_enabled: s.motion_enabled,
          armed: s.armed,
          build: s.build,
          boot: s.boot,
          capabilities: s.capabilities,
        }); })
        .catch(() => {
          if (token === statusGeneration) unavailable();
        })
        .finally(() => { if (token === statusGeneration) clearTimeout(statusDeadline); });
    };
    checkStatus();
    const interval = setInterval(checkStatus, 5000);
    return () => { clearInterval(interval); clearTimeout(statusDeadline); statusGeneration++; statusAbort?.abort(); };
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

  // Auto-dismiss error toast
  useEffect(() => {
    if (!errorToast) return;
    const timer = setTimeout(() => setErrorToast(null), 6000);
    return () => clearTimeout(timer);
  }, [errorToast]);

  const handleAIResponse = useCallback((response) => {
    if (response.program) {
      setPendingSuggestion({
        program: response.program,
        explanation: response.explanation || '',
      });
      // Drafts do not change the current project's Python. Apply regenerates
      // it from the final (replaced or appended) block program.
    }
    // First chat achievement
    const b = tryEarnBadge('first_chat');
    if (b) setCelebrationQueue(prev => [...prev, { badge: b, type: 'confetti' }]);
  }, []);

  const handleBlocksChange = useCallback((newBlocks) => {
    commitBlocks(newBlocks);
    setPendingSuggestion(null);
  }, [commitBlocks]);

  const handleApplySuggestion = useCallback(() => {
    if (!pendingSuggestion?.program) return;
    const merged = applyMode === 'append'
      ? [...blocks, ...pendingSuggestion.program]
      : pendingSuggestion.program;
    commitBlocks(merged);
    setPendingSuggestion(null);
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
  }, [historyIndex, blockHistory]);

  const handleRedo = useCallback(() => {
    if (historyIndex >= blockHistory.length - 1) return;
    const nextIndex = historyIndex + 1;
    const nextBlocks = blockHistory[nextIndex] || [];
    setHistoryIndex(nextIndex);
    setBlocks(nextBlocks);
    setPendingSuggestion(null);
  }, [historyIndex, blockHistory]);

  const handleRunProgram = useCallback(async () => {
    if (blocks.length === 0 || activeRun.current || programBlocked) return;
    const run = { id: null, events: new Map(), encoding: programEncoding, controller: new AbortController(),
      submission: captureSubmission({ blocks, profileId: currentProfileId, robotConfig }) };
    activeRun.current = run;
    setProgramLifecycle({ text: 'Submitting program…', pending: true });
    const award = event => {
      const { badges, challenges } = completeSubmission(run.submission, event, currentProfileRef.current);
      const missionAwards = challenges.map(c => ({ id: c.id, name: c.title, icon: c.icon, description: 'Mission earned — device-confirmed program!' }));
      setProgressVersion(v => v + 1);
      setCelebrationQueue(prev => [...prev, ...[...missionAwards, ...badges].map(badge => ({ badge, type: 'confetti' }))]);
      badges.forEach(() => playAchievement());
    };
    run.dispose = () => {
      clearTimeout(run.timer);
      run.controller.abort();
      run.socket?.close();
      run.events.clear();
    };
    const finish = (text) => {
      if (activeRun.current !== run) return;
      activeRun.current = null;
      run.dispose();
      setProgramLifecycle({ text, pending: false });
    };
    // Absolute observation deadline, not refreshed by telemetry/noisy events.
    run.timer = setTimeout(() => finish('Unverified — timed out waiting for device confirmation; the robot may still be running.'), programEvidenceProfile(run.encoding).observationMs);
    const observe = event => {
      if (activeRun.current !== run || event.run_id !== run.id) return;
      if (['completed', 'failed', 'canceled'].includes(event.event)) {
        if (event.type !== 'program') return; // A block ending is not a program ending.
        if (run.stopRequested && event.event === 'completed') {
          finish(`Unverified — device reported completion after Stop; device stop is not confirmed (${run.id}).`);
          return; // Stop revoked award rights; late completion is not cancellation.
        }
        const label = { completed: 'Completed', failed: 'Failed', canceled: 'Canceled' }[event.event];
        const detail = event.details ? ` — ${typeof event.details === 'string' ? event.details.slice(0, 300) : JSON.stringify(event.details).slice(0, 300)}` : '';
        finish(`${label} — device confirmed (${run.id})${detail}`);
        if (event.event === 'completed') award(event);
        else { cancelSubmission(run.submission); if (event.event === 'failed') playError(); }
      } else if (['accepted', 'started'].includes(event.event)) {
        if (run.stopRequested) return; // Do not overwrite the unconfirmed Stop warning.
        // Do not regress started to accepted when events arrive out of order.
        if (run.started && event.event === 'accepted') return;
        if (event.event === 'started') run.started = true;
        setProgramLifecycle({ text: `${run.started ? 'Started' : 'Accepted'} — device confirmed (${run.id})`, pending: true });
      }
    };
    try {
      // Existing sockets are private to conditionally-mounted LiveControl/Debug
      // components; there is no shared hook. Observe only for this run and close
      // on every terminal path. Open before POST so fast device events aren't lost.
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
      run.socket = socket;
      socket.onmessage = message => {
        if (activeRun.current !== run) return;
        try {
          const msg = JSON.parse(message.data);
          if (msg.type !== 'mqtt' || msg.topic !== 'robot/execution' || typeof msg.data?.run_id !== 'string') return;
          if (run.id) observe(msg.data);
          else {
            // Before HTTP reveals our run ID, keep at most one program-level
            // lifecycle per run, not thousands of primitive events. First
            // terminal wins; noise cannot evict a failed/canceled outcome.
            const event = msg.data;
            if (event.type !== 'program' || !['accepted', 'started', 'completed', 'failed', 'canceled'].includes(event.event)
              || !event.run_id || event.run_id.length > 128) return;
            const previous = run.events.get(event.run_id);
            if (!previous && run.events.size >= 32) { run.earlyOverflow = true; return; }
            if (previous && (['completed', 'failed', 'canceled'].includes(previous.event)
              || (previous.event === 'started' && event.event === 'accepted'))) return;
            run.events.set(event.run_id, { type: 'program', run_id: event.run_id, event: event.event,
              details: event.details ? (typeof event.details === 'string' ? event.details : JSON.stringify(event.details)).slice(0, 300) : undefined });
          }
        } catch { /* malformed telemetry cannot complete a run */ }
      };
      await new Promise(resolve => {
        socket.onopen = resolve;
        socket.onerror = resolve; // HTTP can still submit; timeout remains unverified.
        socket.onclose = resolve;
      });
      if (activeRun.current !== run) return;
      playProgramSent();
      const res = await fetch('/api/robot/program', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ program: run.submission.blocks }),
        signal: run.controller.signal,
      });
      if (activeRun.current !== run) return;
      const data = await res.json();
      if (activeRun.current !== run) return;
      if (!res.ok || data.error) {
        playError();
        const error = data.error || `HTTP ${res.status}`;
        finish(`Submission failed — ${error}`);
        setErrorToast(data.hint ? `Could not send to robot: ${error} — ${data.hint}` : `Could not send to robot: ${error}`);
      } else if (typeof data.run_id === 'string' && data.run_id) {
        run.id = data.run_id;
        acceptSubmission(run.submission, data);
        // The accepted encoding must match the profile captured before Run.
        // Re-read only the immutable submission, never the now-editable blocks.
        if (run.encoding === 'indexed-v1') {
          try {
            run.submission.evidence = readProgramEvidence(run.submission.blocks, run.encoding);
            run.submission.verified = data.encoding === run.encoding && agreesWithServer(run.submission.evidence, run.submission.response);
          } catch { run.submission.verified = false; }
        } else if (data.encoding === 'indexed-v1') run.submission.verified = false;
        setProgramLifecycle({ text: `Submitted — awaiting device confirmation (${run.id})`, pending: true });
        const earlyEvent = run.events.get(run.id);
        run.events.clear();
        if (earlyEvent) observe(earlyEvent);
        else if (run.earlyOverflow) {
          cancelSubmission(run.submission);
          finish('Unverified — too many unrelated early program events; device completion cannot be safely confirmed.');
        }
      } else if (robotStatus.application === 'cooperative-v1') {
        finish('Unverified — submission returned no run ID; device completion cannot be confirmed.');
      } else {
        finish('Unverified — transport acknowledgement only; no device-completed run ID.');
      }
    } catch (err) {
      if (activeRun.current !== run) return;
      finish('Unverified — error sending program: ' + err.message);
      playError();
      setErrorToast('Error sending program: ' + err.message);
    }
  }, [blocks, robotStatus.application, programBlocked, programEncoding, currentProfileId, robotConfig]);

  const handleStop = useCallback(async () => {
    // Abandon any pending helper continuation and draft. Remount resets its
    // pending UI; epoch-bound callbacks cannot apply a late generated response.
    helperGeneration.current++;
    setHelperEpoch(helperGeneration.current);
    setPendingSuggestion(null);
    // Children cancel local holds/queues synchronously, without calling us back.
    window.dispatchEvent(new CustomEvent('mbot-global-stop'));
    // An already received HTTP request may still run server-side: always send
    // emergency Stop as well (including during recording asset synchronization).
    const run = activeRun.current;
    if (run?.id) {
      // A known submission keeps only bounded device observation. Revoke awards
      // synchronously, but don't mistake the Stop HTTP ACK for device cancellation.
      run.stopRequested = true;
      cancelSubmission(run.submission);
      run.controller.abort();
      setProgramLifecycle({ text: `Stop requested — device stop is not confirmed (${run.id}).`, pending: true });
    } else {
      // Before an ID is known, revoke every async continuation (including a late
      // observer-open callback) so no POST or response can revive this run.
      cancelActiveRun('Canceled locally — Stop requested; device stop is not confirmed.');
    }
    playStop();
    try {
      await fetch('/api/robot/stop', { method: 'POST' });
    } catch (err) {
      console.error('Stop error:', err);
    }
  }, [cancelActiveRun]);

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
    const loadedBlocks = proj.blocks || [];
    restoreBlocks(loadedBlocks, proj.pythonCode);
    resetBlockHistory(loadedBlocks);
    setMessages(proj.messages && proj.messages.length > 0 ? proj.messages : [DEFAULT_WELCOME]);
    setPendingSuggestion(null);
    saveCurrentProjectId(currentProfileId, proj.id);
  }, [currentProfileId, resetBlockHistory, restoreBlocks]);

  const handleProjectNew = useCallback(() => {
    if (!currentProfileId) return;
    setProjectId(null);
    setProjectName('Untitled Project');
    const emptyBlocks = [];
    restoreBlocks(emptyBlocks);
    resetBlockHistory(emptyBlocks);
    setMessages([DEFAULT_WELCOME]);
    setPendingSuggestion(null);
    saveCurrentProjectId(currentProfileId, null);
  }, [currentProfileId, resetBlockHistory, restoreBlocks]);

  const handleProfileSwitch = useCallback((profileId) => {
    cancelActiveRun('Canceled locally — profile changed; the robot may still be running.');
    setCurrentProfileId(profileId);
    saveCurrentProfileId(profileId);
  }, [cancelActiveRun]);

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
    cancelActiveRun('Canceled locally — profile changed; the robot may still be running.');
    setCurrentProfileId(newProfile.id);
    saveCurrentProfileId(newProfile.id);
    return true;
  }, [profiles, cancelActiveRun]);

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
    // Deterministic unfinished starter; no AI, no auto-run, no full solution.
    if (blocks.length && !window.confirm('Load this mission starter? Save any work you want to keep first.')) return;
    const starter = structuredClone(challenge.starter);
    commitBlocks(starter);
    setProjectId(null);
    setProjectName(challenge.title);
    saveCurrentProjectId(currentProfileId, null);
    setPendingSuggestion(null);
    setActiveMission(challenge);
    setShowCode(false);
    setActiveTab(TABS.PROGRAM);
    playClick();
  }, [blocks.length, commitBlocks, currentProfileId]);


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
    setShowTemplates(false);
    playClick();
  }, [commitBlocks]);

  const handleSoundToggle = useCallback(() => {
    const newMuted = !soundMuted;
    setSoundMuted(newMuted);
    setMuted(newMuted);
  }, [soundMuted]);

  const achievementProgress = getProgress(currentProfileId);

  return (
    <div className="app guided-app">
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
        onStop={handleStop}
      />

      <div className="test-workspace-banner">Test workspace — shares robot and settings with main Studio</div>

      <div className="app-content">
        {activeTab === TABS.PROGRAM && (
          <div className="program-layout">
            <aside className="mission-rail" aria-label="Mission checklist">
              {activeMission ? <MissionStrip challenge={activeMission} blocks={blocks} currentProfileId={currentProfileId} robotConfig={robotConfig}
                onClose={() => setActiveMission(null)} onViewChallenges={() => setActiveTab(TABS.CHALLENGES)} /> : (
                <div className="mission-empty">
                  <h2><StudioIcon name="flag" /> Your mission</h2>
                  <p>Build freely, or choose a small programming goal to work toward.</p>
                  <button className="btn-primary" onClick={() => setActiveTab(TABS.CHALLENGES)}>Choose a mission</button>

                </div>
              )}
              <details className="editing-hints" open={guidanceOpen} onToggle={event => setGuidanceOpen(event.currentTarget.open)}>
                <summary>A little guidance</summary>
                <p>Add blocks, then connect them under “when program starts”. Select a value to edit it.</p>
                <p>Check the program before running. Keep space around the robot clear.</p>
                <p className="mission-credit-note">Mission credit needs a matching, device-completed program. Editing alone does not earn it.</p>
                <button className="mission-link" onClick={openHelper}><StudioIcon name="helper" /> Open Helper</button>
              </details>
            </aside>
            <div className="panel chat-panel-container" hidden={!showHelper} role="complementary" aria-label="AI helper">
              <div className="helper-panel-heading"><h2>AI helper</h2><button ref={helperCloseButton} className="btn-secondary" aria-label="Close helper" onClick={closeHelper}><StudioIcon name="close" /> Close</button></div>
              <ChatPanel
                key={helperEpoch}
                messages={messages}
                setMessages={next => { if (helperEpoch === helperGeneration.current) setMessages(next); }}
                onAIResponse={response => { if (helperEpoch === helperGeneration.current) handleAIResponse(response); }}
                currentBlocks={blocks}
              />
            </div>

            <div className="panel blocks-panel-container">
              <div className="panel-header">
                <div>
                  <h2>Block Program</h2>
                  <div className="panel-subtitle">Build a sequence, check it, then run it on your robot.</div>
                </div>
                <div className="panel-actions">
                  <RobotDiagnostics onStop={handleStop} />
                  <button className="btn-secondary btn-small" aria-label="AI helper" aria-expanded={showHelper} onClick={showHelper ? closeHelper : openHelper}><StudioIcon name="helper" /> Helper</button>
                  <button
                    className="btn-secondary btn-small"
                    onClick={handleUndo}
                    disabled={historyIndex <= 0}
                    title="Undo"
                  >
                    <StudioIcon name="undo" /> Undo
                  </button>
                  <button
                    className="btn-secondary btn-small"
                    onClick={handleRedo}
                    disabled={historyIndex >= blockHistory.length - 1}
                    title="Redo"
                  >
                    <StudioIcon name="redo" /> Redo
                  </button>
                  <button
                    className="btn-secondary btn-small"
                    onClick={() => setShowTemplates(!showTemplates)}
                    title="Program templates"
                  >
                    <StudioIcon name="book" /> Templates
                  </button>
                  <button
                    className="btn-secondary"
                    onClick={() => setShowCode(!showCode)}
                  >
                    <StudioIcon name={showCode ? 'program' : 'code'} /> {showCode ? 'Show Blocks' : 'Show Python'}
                  </button>
                  <button className="btn-danger" onClick={handleStop} title="Stop program" aria-label="🛑 STOP"><StudioIcon name="stop" /> STOP</button>
                  <button
                    className="btn-primary"
                    onClick={handleRunProgram}
                    disabled={blocks.length === 0 || programLifecycle?.pending || programBlocked}
                  >
                    <StudioIcon name="play" /> Run Program
                  </button>
                </div>
              </div>


              <div className={`program-readiness ${programBlocked || disconnectedCount ? 'needs-attention' : ''}`} role="status" data-testid="program-readiness">
                {disconnectedCount > 0 && <span>{disconnectedCount} block{disconnectedCount === 1 ? '' : 's'} not connected — won't run. Use “Connect to program” or snap them under “when program starts”. </span>}
                {!blocks.length ? (disconnectedCount ? 'No blocks connected to start.' : 'Start here: add a block from the library.') : checkRuntime ? (
                  !robotStatus.robotOnline ? 'Robot offline — you can keep editing.' :
                  !checkIsCurrent || programCheck?.checking ? 'Checking this program…' :
                  programCheck?.runnable ? readinessSummary :
                  `Needs attention: ${programCheck?.error || 'This program cannot run on the connected robot.'}`
                ) : 'Program support depends on the connected robot runtime.'}
              </div>
              {showCode && <div className="program-preview-note">Python is a source preview. Run sends the checked block program, not this Python file.</div>}

              {programLifecycle && (
                <div className="program-lifecycle" role="status" data-testid="program-lifecycle">{programLifecycle.text}</div>
              )}

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
                  <TemplateGallery onLoadTemplate={handleTemplateLoad} robotConfig={robotConfig} robotStatus={robotStatus} />
                </div>
              )}

              {showCode ? (
                preview?.blocks === blocks && preview.status === 'error' ? (
                  <div role="alert">{preview.error}</div>
                ) : blocks.length > 0 && (preview?.blocks !== blocks || preview.status === 'pending') ? (
                  <div role="status">Generating Python preview…</div>
                ) : <CodePreview code={pythonCode} blocks={blocks} />
              ) : (
                <BlocklyEditor
                  guidedMode={true}
                  blocks={blocks}
                  onBlocksChange={handleBlocksChange}
                  onDisconnectedBlocksChange={setDisconnectedCount}
                  robotConfig={robotConfig}
                  robotStatus={robotStatus}
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

              robotConfig={robotConfig}
              progressVersion={progressVersion}
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
            onStop={handleStop}
            config={robotConfig}
            onConfigUpdate={handleConfigUpdate}
            robotConnected={robotStatus.connected}
            onAchievement={handleAchievement}
          />
        )}

        {activeTab === TABS.DEBUG && (
          <DebugTerminal robotConnected={robotStatus.connected} />
        )}
      </div>

      <Celebrations
        celebrationQueue={celebrationQueue}
        onCelebrationDone={handleCelebrationDone}
      />

      {errorToast && (
        <div className="error-toast" onClick={() => setErrorToast(null)}>
          <span className="error-toast-icon">😵</span>
          <span className="error-toast-msg">{errorToast}</span>
          <button className="error-toast-close" onClick={() => setErrorToast(null)}>✕</button>
        </div>
      )}

      <StatusBar
        robotConnected={robotStatus.connected}
        robotStatus={robotStatus}
        soundMuted={soundMuted}
        onSoundToggle={handleSoundToggle}
      />
    </div>
  );
}

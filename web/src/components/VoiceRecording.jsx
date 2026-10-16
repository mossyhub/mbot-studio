import React, {useEffect, useId, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {MAX_RECORDING_MS, canUseRecordings, recordingSupport, listRecordings,
  uploadRecording, deleteRecording, syncRecording, recordingBlock, recordingAudioUrl} from '../services/voice-recording.js';
import './VoiceRecording.css';

/** onSelect receives a new {type:'play_recording', recording:id} block only on Use clip. */
export default function VoiceRecording({runtimeStatus, onSelect, onRecordingsChange}) {
  const id = useId();
  const enabled = canUseRecordings(runtimeStatus);
  const support = recordingSupport();
  const [phase, setPhase] = useState('idle');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [name, setName] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [draft, setDraft] = useState(null);
  // A ready receipt belongs to this observed robot connection, not the local
  // asset. Include connection loss even when the heartbeat/boot stays cached.
  const identity = JSON.stringify([runtimeStatus?.boot ?? null, runtimeStatus?.build ?? null,
    runtimeStatus?.application ?? null, runtimeStatus?.robotOnline === true,
    runtimeStatus?.mqttConnected ?? null, enabled]);
  const [library, setLibrary] = useState({identity:null, rows:[]});
  const assets = useMemo(() => library.identity === identity && enabled ? library.rows
    : library.rows.map(row => ({...row, ready:false})), [library, identity, enabled]);
  const setAssets = update => setLibrary(previous => ({identity,
    rows: typeof update === 'function' ? update(previous.rows) : update}));
  const [selected, setSelected] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => { onRecordingsChange?.(assets); }, [assets, onRecordingsChange]);
  const current = useRef(null);
  const generation = useRef(0);
  const listGeneration = useRef(0);
  const listAbort = useRef(null);
  const draftUrl = useRef(null);
  const audio = useRef(null);
  const mounted = useRef(true);
  const stopPreview = () => {
    if (audio.current) { audio.current.pause(); audio.current.removeAttribute('src'); audio.current.load(); }
  };
  const clearDraft = () => {
    stopPreview();
    if (draftUrl.current) URL.revokeObjectURL(draftUrl.current);
    draftUrl.current = null;
    setDraft(null);
  };
  const stopTracks = session => session?.stream?.getTracks().forEach(track => { try { track.stop(); } catch { /* Stop other tracks too. */ } });
  const stopTimers = session => { clearTimeout(session?.limit); clearInterval(session?.ticker); };
  const cancel = () => {
    generation.current++;
    const session = current.current;
    current.current = null;
    stopTimers(session);
    session?.abort?.abort();
    if (session?.recorder) {
      session.recorder.ondataavailable = session.recorder.onstop = session.recorder.onerror = null;
      try { if (session.recorder.state !== 'inactive') session.recorder.stop(); } catch { /* Tracks still stop. */ }
    }
    stopTracks(session);
    clearDraft();
    setPhase('idle'); setElapsed(0);
  };
  const refresh = async () => {
    const token = ++listGeneration.current;
    listAbort.current?.abort();
    const controller = new AbortController(); listAbort.current = controller;
    setLoading(true);
    try {
      const rows = await listRecordings({signal:controller.signal});
      if (!mounted.current || token !== listGeneration.current) return;
      setAssets(rows); setSelected(value => rows.some(row=>row.id===value) ? value : '');
    } catch (err) {
      if (mounted.current && token===listGeneration.current && err.name!=='AbortError') setError(err.message);
    } finally { if (mounted.current && token===listGeneration.current) setLoading(false); }
  };
  useLayoutEffect(() => {
    mounted.current = true;
    // Scrub receipts on every transition (including same-boot reconnect), but
    // retain names/IDs/duration and local preview. Cleanup fences operations
    // before a replacement identity can interact with the UI.
    setAssets(rows => rows.map(row => ({...row, ready:false})));
    setNotice(''); setError('');
    refresh();
    return () => {
      mounted.current = false; listGeneration.current++; listAbort.current?.abort(); cancel();
    };
  }, [identity]);

  const record = async () => {
    if (!enabled || support.error || current.current) return;
    clearDraft(); setError(''); setNotice(''); setElapsed(0); setPhase('permission');
    const token = ++generation.current;
    const session = {token}; current.current = session;
    const active = () => mounted.current && token === generation.current;
    const fail = err => {
      if (!active()) return;
      cancel();
      setError(err.name === 'NotAllowedError' ? 'Microphone permission was denied. Allow microphone access in your browser, then choose Record again.'
        : err.name === 'NotFoundError' ? 'No microphone was found. Connect a microphone and try again.' : `Recording failed: ${err.message || 'microphone unavailable'}. Try again.`);
    };
    try {
      const stream = await navigator.mediaDevices.getUserMedia({audio:true, video:false});
      if (!active()) { stopTracks({stream}); return; }
      session.stream = stream;
      const recorder = new MediaRecorder(stream, {mimeType:support.mimeType});
      session.recorder = recorder;
      const chunks = [];
      recorder.ondataavailable = event => { if (active() && event.data.size) chunks.push(event.data); };
      recorder.onerror = event => fail(event.error || new Error('Audio encoder stopped'));
      recorder.onstop = () => {
        stopTimers(session); stopTracks(session);
        if (!active()) return;
        current.current = null;
        try {
          const blob = new Blob(chunks, {type:recorder.mimeType || support.mimeType});
          if (!blob.size) throw new Error('No audio was captured');
          const url = URL.createObjectURL(blob); draftUrl.current = url;
          setDraft({blob,url}); setPhase('draft');
        } catch (err) { fail(err); }
      };
      session.stop = () => {
        if (!active() || session.stopping) return;
        session.stopping = true; stopTimers(session);
        setElapsed(Math.min(MAX_RECORDING_MS, performance.now()-session.started));
        setPhase('finishing');
        try { if (recorder.state !== 'inactive') recorder.stop(); }
        catch (err) { fail(err); }
        finally { stopTracks(session); }
      };
      stream.getTracks().forEach(track => track.addEventListener('ended', () => {
        if (!session.stopping && active()) fail(new Error('Microphone disconnected'));
      }, {once:true}));
      recorder.start(); session.started = performance.now();
      // Independent deadline: never rely on UI elapsed-state updates or data chunks.
      session.limit = setTimeout(session.stop, MAX_RECORDING_MS);
      session.ticker = setInterval(()=>{ if(active())setElapsed(Math.min(MAX_RECORDING_MS,performance.now()-session.started)); },100);
      setPhase('recording');
    } catch (err) { fail(err); }
  };
  const save = async () => {
    if (!enabled || !draft || current.current) return;
    stopPreview(); setError(''); setNotice(''); setPhase('uploading');
    const token = ++generation.current;
    const abort = new AbortController(); current.current = {abort,token};
    // An older list response must not overwrite the newly saved asset.
    listGeneration.current++; listAbort.current?.abort(); setLoading(false);
    try {
      const asset = await uploadRecording(draft.blob,{name,signal:abort.signal});
      if (!mounted.current || token !== generation.current) return;
      current.current = null;
      setAssets(rows=>[asset,...rows.filter(row=>row.id!==asset.id)]); setSelected(asset.id);
      clearDraft(); setPhase('idle'); setNotice(asset.ready ? 'Clip saved. Choose Use clip to add it to your program.' : 'Saved on Studio. Choose Sync to robot before using this clip.');
    } catch (err) {
      if (mounted.current && token===generation.current) {
        current.current = null; setPhase('draft'); if(err.name!=='AbortError')setError(err.message);
      }
    }
  };
  const sync = async () => {
    if (!enabled || !selected || current.current) return;
    stopPreview(); setError(''); setNotice(''); setPhase('syncing');
    const token=++generation.current, abort=new AbortController(); current.current={token,abort};
    listGeneration.current++; listAbort.current?.abort(); setLoading(false);
    try {
      const row=await syncRecording(selected,{signal:abort.signal});
      if (!mounted.current || token!==generation.current) return;
      setAssets(rows=>rows.map(old=>old.id===row.id?row:old));
      setNotice(row.ready ? 'Clip verified on the robot. Choose Use clip to add it to your program.' : 'Robot verification is not ready. Refresh or try syncing again.');
    } catch(err) { if(mounted.current && token===generation.current && err.name!=='AbortError')setError(err.message); }
    finally { if(mounted.current && token===generation.current){current.current=null;setPhase(draft?'draft':'idle');} }
  };
  const remove = async () => {
    if (!selected || current.current) return;
    stopPreview(); setError(''); setPhase('deleting');
    const token=++generation.current, abort=new AbortController(); current.current={token,abort};
    listGeneration.current++; listAbort.current?.abort(); setLoading(false);
    try {
      await deleteRecording(selected,{signal:abort.signal});
      const rows=await listRecordings({signal:abort.signal});
      if (!mounted.current || token!==generation.current) return;
      if(rows.some(row=>row.id===selected))throw new Error('Deletion was not confirmed. Refresh and try again.');
      setAssets(rows);setSelected('');setNotice('Clip deleted. Existing program blocks that reference it will need another clip.');
    } catch(err) { if(mounted.current && token===generation.current && err.name!=='AbortError')setError(err.message); }
    finally { if(mounted.current && token===generation.current){current.current=null;setPhase(draft?'draft':'idle');} }
  };
  const preview = async src => {
    setError('');stopPreview();audio.current.src=src;
    try { await audio.current.play(); }
    catch { if(mounted.current)setError('Preview could not play. Try recording again or use a browser that supports this audio format.'); }
  };
  const asset=assets.find(row=>row.id===selected);
  const busy=['permission','recording','finishing','uploading','deleting','syncing'].includes(phase);
  return <section className="voice-recording" aria-labelledby={`${id}-heading`}>
    <h3 id={`${id}-heading`}>Voice clips</h3>
    <p className="voice-help">Record up to 3 seconds. Preview here, then save to this Studio server.</p>
    {!enabled && <p className="voice-unavailable">Unavailable — waiting for installed recorded-audio support and an online robot.</p>}
    {support.error && <p className="voice-unavailable">{support.error}</p>}
    <label htmlFor={`${id}-name`}>Clip name</label>
    <input id={`${id}-name`} value={name} maxLength={80} placeholder="e.g. Hello robot" disabled={busy} onChange={e=>setName(e.target.value)}/>
    <div className="voice-actions">
      <button type="button" className="voice-primary" disabled={!enabled || !!support.error || busy || !!draft} onClick={record}>Record</button>
      <button type="button" disabled={phase!=='recording'} onClick={()=>current.current?.stop?.()}>Stop</button>
      <span className="voice-timer" aria-label="Recording time">{(elapsed/1000).toFixed(1)} / 3 s</span>
      {busy && <button type="button" onClick={()=>{cancel();setNotice('Canceled here. A save or sync already received by the server may finish. Refresh to check.');}}>Cancel</button>}
    </div>
    <p role="status" className="voice-help">{phase==='permission'?'Waiting for microphone permission…':phase==='recording'?'Recording… stops automatically at 3 seconds.':phase==='finishing'?'Finishing clip…':phase==='uploading'?'Saving clip…':phase==='deleting'?'Deleting clip…':phase==='syncing'?'Sending clip to robot and waiting for verification…':notice}</p>
    {draft && <div className="voice-actions" aria-label="Draft clip">
      <button type="button" disabled={busy} onClick={()=>preview(draft.url)}>Preview draft</button>
      <button type="button" disabled={busy || !enabled} className="voice-primary" onClick={save}>Save clip</button>
      <button type="button" disabled={busy} onClick={()=>{cancel();setNotice('Draft deleted.');}}>Delete draft</button>
    </div>}
    <div className="voice-library">
      <label htmlFor={`${id}-saved`}>Saved clip</label>
      <select id={`${id}-saved`} value={selected} disabled={busy} onChange={e=>{stopPreview();setSelected(e.target.value);}}>
        <option value="">{loading?'Loading clips…':assets.length?'Choose a clip':'No saved clips yet'}</option>
        {assets.map(row=><option key={row.id} value={row.id}>{row.name || 'Untitled clip'} · {(row.durationMs/1000).toFixed(1)} s{row.ready?'':' · not ready'}</option>)}
      </select>
      <div className="voice-actions">
        <button type="button" disabled={!asset || busy} onClick={()=>preview(recordingAudioUrl(asset.id))}>Preview</button>
        {asset && !asset.ready && <button type="button" disabled={!enabled || busy} onClick={sync}>Sync to robot</button>}
        <button type="button" disabled={!enabled || !asset?.ready || busy || !onSelect} className="voice-primary" onClick={()=>onSelect(recordingBlock(asset))}>Use clip</button>
        <button type="button" disabled={!asset || busy} onClick={remove}>Delete</button>
        <button type="button" disabled={loading || busy} onClick={()=>{setError('');refresh();}}>Refresh</button>
      </div>
    </div>
    {error && <p className="voice-error" role="alert">{error}</p>}
    <audio ref={audio} preload="none" onError={()=>setError('Preview could not load. Refresh the clip list or record a new clip.')} />
    <p className="voice-help">Microphone access starts only when you choose Record. The server checks the duration and converts supported audio for the robot. Preview plays on this device, not on the robot.</p>
  </section>;
}

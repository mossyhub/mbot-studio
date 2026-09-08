import React, { useEffect, useRef, useState } from 'react';
import './RobotDiagnostics.css';

export default function RobotDiagnostics({ onStop }) {
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const dialog = useRef(null);
  useEffect(() => {
    if (!open) return;
    dialog.current?.showModal();
    const controller = new AbortController();
    let current = true;
    setLoading(true); setError('');
    fetch('/api/robot/diagnostics', { signal: controller.signal }).then(async response => {
      if (!response.ok) throw Error(`Server returned HTTP ${response.status}`);
      const data = await response.json();
      if (current) setReport(data);
    }).catch(error => { if (current) setError(error.message); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; controller.abort(); };
  }, [open, revision]);
  const close = () => { dialog.current?.close(); setOpen(false); setReport(null); };
  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'mbot-diagnostics.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const sensors = report?.lastKnown?.sensors;
  return <>
    <button className="btn-secondary btn-small" aria-label="Robot diagnostics" onClick={() => setOpen(true)}>Diagnostics</button>
    {open && <dialog ref={dialog} className="robot-diagnostics" aria-labelledby="robot-diagnostics-title" onCancel={close}>
      <header><h2 id="robot-diagnostics-title">Robot diagnostics</h2><button className="diagnostic-stop" aria-label="Emergency Stop" onClick={onStop}>STOP</button><button aria-label="Close diagnostics" onClick={close}>Close</button></header>
      <p>Server-recorded evidence survives robot disconnects. An offline event does not establish a battery protection cutoff. Battery percentage is not voltage.</p>
      <div className="diagnostic-actions"><button onClick={() => setRevision(x => x + 1)} disabled={loading}>Refresh report</button><button onClick={download} disabled={!report || loading || !!error}>Download diagnostic report</button></div>
      {loading && <p role="status">Loading recorded evidence…</p>}
      {error && <p role="alert">Could not load diagnostics: {error}</p>}
      {report && <>
        <p role="status">{report.recording?.healthy === true ? 'Recorder healthy' : 'Recorder status unavailable or degraded'}{report.recording?.lastError ? ` — ${report.recording.lastError}` : ''}</p>
        <p>Last received battery: {typeof sensors?.payload?.battery === 'number' ? `${sensors.payload.battery}%` : 'Unknown'} · {sensors?.receivedAt ? new Date(sensors.receivedAt).toLocaleString() : 'No sensor snapshot recorded'}</p>
        <p>Recording is passive: refreshing this report never requests sensors or moves the robot. The export contains retained command parameters and device messages.</p>
        <ol className="diagnostic-events" reversed>{(report.events || []).slice(-40).reverse().map((event, index) => <li key={event.id || index}><time>{new Date(event.time).toLocaleTimeString()}</time> <strong>{event.kind}</strong><pre>{JSON.stringify(event.data, null, 2)}</pre></li>)}</ol>
      </>}
    </dialog>}
  </>;
}

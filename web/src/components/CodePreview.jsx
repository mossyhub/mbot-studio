import React, { useState } from 'react';
import './CodePreview.css';

export default function CodePreview({ code, blocks }) {
  const [copied, setCopied] = useState(false);
  const [usbConnected, setUsbConnected] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [usbStatus, setUsbStatus] = useState('');
  const [port, setPort] = useState(null);

  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  const supportsWebSerial = typeof navigator !== 'undefined' && !!navigator.serial;

  const writeBytes = async (writer, bytes) => {
    await writer.write(bytes);
  };

  const writeText = async (writer, text) => {
    const encoder = new TextEncoder();
    await writer.write(encoder.encode(text));
  };

  const readWithTimeout = async (reader, timeoutMs) => {
    let timeoutHandle;
    try {
      const timeoutPromise = new Promise(resolve => {
        timeoutHandle = setTimeout(() => resolve({ timeout: true }), timeoutMs);
      });
      const readPromise = reader.read();
      const result = await Promise.race([readPromise, timeoutPromise]);
      if (result?.timeout) return { timeout: true, value: '' };
      if (result?.done) return { done: true, value: '' };
      const decoder = new TextDecoder();
      return { value: decoder.decode(result.value || new Uint8Array()) };
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  };

  const waitForText = async (reader, expectedText, timeoutMs = 5000) => {
    const started = Date.now();
    let buffer = '';

    while ((Date.now() - started) < timeoutMs) {
      const chunk = await readWithTimeout(reader, 250);
      if (chunk?.value) {
        buffer += chunk.value;
        if (buffer.includes(expectedText)) {
          return { ok: true, buffer };
        }
      }
      if (chunk?.done) break;
    }

    return { ok: false, buffer };
  };

  const connectUsb = async () => {
    if (!supportsWebSerial) {
      setUsbStatus('Web Serial is not available. Use Chrome or Edge over HTTPS/localhost.');
      return;
    }

    try {
      const selectedPort = await navigator.serial.requestPort({ filters: [] });
      await selectedPort.open({ baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });
      setPort(selectedPort);
      setUsbConnected(true);
      setUsbStatus('USB connected. Ready to upload main.py');
    } catch (error) {
      setUsbStatus(`USB connect failed: ${error.message}`);
    }
  };

  const disconnectUsb = async () => {
    if (!port) return;
    try {
      await port.close();
    } catch {
      // ignore close errors
    }
    setPort(null);
    setUsbConnected(false);
    setUsbStatus('USB disconnected');
  };

  const toBase64 = (text) => {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  };

  const chunkString = (str, size) => {
    const chunks = [];
    for (let i = 0; i < str.length; i += size) {
      chunks.push(str.slice(i, i + size));
    }
    return chunks;
  };

  const uploadViaUsb = async () => {
    if (!port || !usbConnected) {
      setUsbStatus('Connect USB first');
      return;
    }
    if (!code?.trim()) {
      setUsbStatus('No code to upload yet');
      return;
    }

    setUploading(true);
    setUsbStatus('Preparing upload...');

    let reader;
    let writer;

    try {
      reader = port.readable.getReader();
      writer = port.writable.getWriter();

      setUsbStatus('Entering MicroPython raw REPL...');
      await writeBytes(writer, new Uint8Array([0x03, 0x03])); // Ctrl-C twice
      await sleep(120);
      await writeBytes(writer, new Uint8Array([0x01])); // Ctrl-A raw repl

      const rawReplResult = await waitForText(reader, 'raw REPL', 6000);
      if (!rawReplResult.ok) {
        throw new Error('Could not enter raw REPL. Make sure CyberPi is in MicroPython mode.');
      }

      const base64 = toBase64(code);
      const chunks = chunkString(base64, 220);
      const listLiteral = chunks.map(c => `'${c}'`).join(',\n    ');

      const uploaderScript = [
        'try:',
        '    import ubinascii as b64',
        'except ImportError:',
        '    import binascii as b64',
        '',
        'chunks = [',
        `    ${listLiteral}`,
        ']',
        'f = open("main.py", "wb")',
        'for c in chunks:',
        '    f.write(b64.a2b_base64(c))',
        'f.close()',
        'print("UPLOAD_OK")',
        '',
      ].join('\n');

      setUsbStatus('Writing main.py ...');
      await writeText(writer, uploaderScript);
      await writeBytes(writer, new Uint8Array([0x04])); // Ctrl-D execute

      const uploadResult = await waitForText(reader, 'UPLOAD_OK', 12000);
      if (!uploadResult.ok) {
        throw new Error('Upload command did not complete. Check REPL mode and try again.');
      }

      // Exit raw repl
      await writeBytes(writer, new Uint8Array([0x02])); // Ctrl-B
      setUsbStatus('✅ Uploaded to main.py successfully');
    } catch (error) {
      setUsbStatus(`Upload failed: ${error.message}`);
    } finally {
      if (reader) {
        try { await reader.cancel(); } catch {}
        try { reader.releaseLock(); } catch {}
      }
      if (writer) {
        try { writer.releaseLock(); } catch {}
      }
      setUploading(false);
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
      const ta = document.createElement('textarea');
      ta.value = code;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleDownload = () => {
    const blob = new Blob([code], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'mbot_program.py';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="code-preview">
      <div className="code-toolbar">
        <span className="code-lang">🐍 MicroPython</span>
        <div className="code-actions">
          {!usbConnected ? (
            <button className="btn-small btn-secondary" onClick={connectUsb} disabled={!supportsWebSerial || uploading}>
              🔌 Connect USB
            </button>
          ) : (
            <>
              <button className="btn-small btn-secondary" onClick={uploadViaUsb} disabled={uploading || !code?.trim()}>
                {uploading ? '⏳ Uploading...' : '⬆️ Upload main.py'}
              </button>
              <button className="btn-small btn-secondary" onClick={disconnectUsb} disabled={uploading}>
                ❌ Disconnect
              </button>
            </>
          )}
          <button className="btn-small btn-secondary" onClick={handleCopy}>
            {copied ? '✅ Copied!' : '📋 Copy'}
          </button>
          <button className="btn-small btn-secondary" onClick={handleDownload}>
            💾 Download
          </button>
        </div>
      </div>

      <div className="code-info">
        <p>This is the Python code that runs on your mBot2. It was generated from your {blocks.length} block{blocks.length !== 1 ? 's' : ''}.</p>
        <p className="code-info-sub">USB upload is experimental and intended for MicroPython mode. Normal runtime still uses MQTT for Program and Live modes.</p>
        {usbStatus && <p className="code-info-status">{usbStatus}</p>}
      </div>

      <pre className="code-block">
        <code>{code || '# No code generated yet.\n# Tell your robot what to do in the chat!'}</code>
      </pre>
    </div>
  );
}

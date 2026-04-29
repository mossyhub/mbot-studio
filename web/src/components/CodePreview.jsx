import React, { useState } from 'react';
import './CodePreview.css';

export default function CodePreview({ code, blocks }) {
  const [copied, setCopied] = useState(false);

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
          <button className="btn-small btn-secondary" onClick={handleCopy}>
            {copied ? '✅ Copied!' : '📋 Copy'}
          </button>
          <button className="btn-small btn-secondary" onClick={handleDownload}>
            💾 Download
          </button>
        </div>
      </div>

      <div className="code-info">
        <p>This is a learning view of Python generated from your {blocks.length} block{blocks.length !== 1 ? 's' : ''}.</p>
        <p className="code-info-sub">This is what your block program looks like in Python! You can copy it to learn how coding works.</p>
      </div>

      <pre className="code-block">
        <code>{code || '# No code generated yet.\n# Tell your robot what to do in the chat!'}</code>
      </pre>
    </div>
  );
}

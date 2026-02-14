import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

const ALLOWED_FILE_RE = /^[a-zA-Z0-9_.-]+$/;

function stripAnsi(text) {
  return String(text || '').replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: true,
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timeoutMs = options.timeoutMs || 0;
    let timeoutHandle = null;
    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        try {
          child.kill();
        } catch {
          // ignore kill errors
        }
      }, timeoutMs);
    }

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      reject(err);
    });

    child.on('close', (code) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (timedOut) {
        return reject(new Error(`Command timed out: ${command} ${args.join(' ')}`));
      }
      resolve({ code, stdout, stderr });
    });
  });
}

async function detectPythonRuntime() {
  const candidates = [
    { command: 'py', baseArgs: ['-3'], label: 'py -3' },
    { command: 'python', baseArgs: [], label: 'python' },
    { command: 'python3', baseArgs: [], label: 'python3' },
  ];

  for (const candidate of candidates) {
    try {
      const result = await runCommand(candidate.command, [...candidate.baseArgs, '--version'], { timeoutMs: 5000 });
      if (result.code === 0) {
        return candidate;
      }
    } catch {
      // try next candidate
    }
  }

  throw new Error('Python 3 was not found. Install Python 3.10+ and ensure it is available in PATH.');
}

async function ensureMpremote(pythonRuntime) {
  try {
    const result = await runCommand(
      pythonRuntime.command,
      [...pythonRuntime.baseArgs, '-m', 'mpremote', '--help'],
      { timeoutMs: 7000 },
    );
    if (result.code === 0) return;
  } catch {
    // handled below
  }

  throw new Error(`Python was found (${pythonRuntime.label}) but mpremote is not installed. Run: ${pythonRuntime.label} -m pip install mpremote`);
}

function normalizeFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('No firmware files were provided for native flashing.');
  }

  return files.map((file) => {
    const name = typeof file?.name === 'string' ? file.name.trim() : '';
    const content = typeof file?.content === 'string' ? file.content : '';
    if (!name || !ALLOWED_FILE_RE.test(name)) {
      throw new Error(`Invalid firmware filename: ${name || '(empty)'}`);
    }
    return { name, content };
  });
}

export async function checkNativeFlashSupport() {
  try {
    const pythonRuntime = await detectPythonRuntime();
    await ensureMpremote(pythonRuntime);
    return {
      ok: true,
      python: pythonRuntime.label,
      installHint: `${pythonRuntime.label} -m pip install mpremote`,
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message,
      installHint: 'Install Python 3.10+ and then run: py -3 -m pip install mpremote',
    };
  }
}

export async function flashFirmwareNative({ files, port }) {
  const pythonRuntime = await detectPythonRuntime();
  await ensureMpremote(pythonRuntime);
  const normalizedFiles = normalizeFiles(files);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbot-studio-flash-'));

  try {
    const localPaths = normalizedFiles.map((file) => {
      const localPath = path.join(tempDir, file.name);
      fs.writeFileSync(localPath, file.content, 'utf-8');
      return { name: file.name, localPath };
    });

    const copyArgs = [...pythonRuntime.baseArgs, '-m', 'mpremote'];
    if (port && typeof port === 'string' && port.trim()) {
      copyArgs.push('connect', port.trim());
    }
    copyArgs.push('fs', 'cp');

    for (const file of localPaths) {
      copyArgs.push(file.localPath, `:${file.name}`);
    }

    const copyResult = await runCommand(pythonRuntime.command, copyArgs, {
      timeoutMs: 120000,
      cwd: tempDir,
    });

    if (copyResult.code !== 0) {
      throw new Error(stripAnsi(copyResult.stderr || copyResult.stdout || 'mpremote fs cp failed'));
    }

    const resetArgs = [...pythonRuntime.baseArgs, '-m', 'mpremote'];
    if (port && typeof port === 'string' && port.trim()) {
      resetArgs.push('connect', port.trim());
    }
    resetArgs.push('exec', 'import machine; machine.reset()');

    const resetResult = await runCommand(pythonRuntime.command, resetArgs, {
      timeoutMs: 15000,
      cwd: tempDir,
    });

    return {
      ok: true,
      python: pythonRuntime.label,
      flashedFiles: normalizedFiles.map(f => f.name),
      copyLog: stripAnsi(copyResult.stdout || copyResult.stderr || '').trim(),
      resetLog: stripAnsi(resetResult.stdout || resetResult.stderr || '').trim(),
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export function formatNativeFlashError(error) {
  const raw = stripAnsi(error?.message || 'Native flashing failed');
  const compact = raw.replace(/\s+/g, ' ').trim();

  if (/could not enter raw repl/i.test(compact)) {
    return {
      error: 'Could not enter MicroPython raw REPL on the selected COM port. Put CyberPi into MicroPython/upload mode, close mBlock/serial monitors, and retry. If needed, set the exact COM port (for example COM4).',
      hint: compact,
      installHint: null,
    };
  }

  if (/Python 3 was not found|mpremote is not installed/i.test(compact)) {
    return {
      error: compact,
      hint: null,
      installHint: 'Install Python 3.10+ and run: py -3 -m pip install mpremote',
    };
  }

  return {
    error: compact,
    hint: null,
    installHint: null,
  };
}

export async function listNativeSerialPorts() {
  const pythonRuntime = await detectPythonRuntime();
  await ensureMpremote(pythonRuntime);

  const script = [
    'import json',
    'from serial.tools import list_ports',
    'ports = []',
    'for p in list_ports.comports():',
    '    ports.append({',
    '        "port": p.device,',
    '        "description": p.description or "",',
    '        "hwid": p.hwid or "",',
    '    })',
    'print(json.dumps(ports))',
  ].join('; ');

  const result = await runCommand(
    pythonRuntime.command,
    [...pythonRuntime.baseArgs, '-c', script],
    { timeoutMs: 12000 },
  );

  if (result.code !== 0) {
    throw new Error(stripAnsi(result.stderr || result.stdout || 'Could not list serial ports'));
  }

  const output = stripAnsi(result.stdout || '').trim();
  if (!output) return [];

  try {
    const parsed = JSON.parse(output);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    return [];
  }
}
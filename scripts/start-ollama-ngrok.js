#!/usr/bin/env node

/**
 * Starts Ollama (if needed), starts ngrok for port 11434, then writes
 * OLLAMA_API_URL=<public_https_url> into the project .env file.
 *
 * Optional flag:
 *   --start-backend  Starts backend service after tunnel is ready.
 *
 * Designed for Windows PowerShell / Command Prompt execution.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const OLLAMA_PORT = 11434;
const NGROK_API_PORT = 4040;
const BACKEND_PORT = Number(process.env.PORT || 6001);
const HOST = '127.0.0.1';
const PROJECT_ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(PROJECT_ROOT, '.env');
const BACKEND_DIR = path.join(PROJECT_ROOT, 'backend');
const SHOULD_START_BACKEND = process.argv.includes('--start-backend');
const DEFAULT_NGROK_PATH_WINDOWS = 'D:/AI/tools/ngrok/ngrok.exe';

function log(msg) {
  console.log(`[setup] ${msg}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runCommand(command, args = [], options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      shell: true,
      windowsHide: true,
      ...options
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      resolve({ code: 1, stdout, stderr: stderr + error.message });
    });

    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function commandExists(commandName) {
  const result = await runCommand('where', [commandName]);
  return result.code === 0;
}

async function isPortInUse(port) {
  const result = await runCommand('netstat', ['-ano', '-p', 'tcp']);
  if (result.code !== 0) {
    throw new Error(`Unable to inspect ports: ${result.stderr || 'netstat failed'}`);
  }

  const lines = result.stdout.split(/\r?\n/);
  return lines.some((line) => line.includes(`:${port}`) && line.toUpperCase().includes('LISTENING'));
}

async function fetchJsonWithTimeout(url, timeoutMs = 2000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch (_err) {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function isOllamaHealthy() {
  const data = await fetchJsonWithTimeout(`http://${HOST}:${OLLAMA_PORT}/api/tags`, 2000);
  return !!(data && typeof data === 'object');
}

async function isBackendHealthy() {
  const data = await fetchJsonWithTimeout(`http://${HOST}:${BACKEND_PORT}/health`, 2000);
  return !!(data && typeof data === 'object' && data.status === 'OK');
}

async function waitFor(checkFn, timeoutMs, intervalMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await checkFn();
    if (ok) return true;
    // eslint-disable-next-line no-await-in-loop
    await sleep(intervalMs);
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms`);
}

function hasNgrokAuthtokenConfigured() {
  if (process.env.NGROK_AUTHTOKEN) return true;

  const cfgPaths = [
    path.join(process.env.LOCALAPPDATA || '', 'ngrok', 'ngrok.yml'),
    path.join(process.env.USERPROFILE || '', '.config', 'ngrok', 'ngrok.yml')
  ].filter(Boolean);

  for (const cfgPath of cfgPaths) {
    if (!fs.existsSync(cfgPath)) continue;
    const content = fs.readFileSync(cfgPath, 'utf8');
    if (/^\s*authtoken\s*:\s*\S+/m.test(content)) {
      return true;
    }
  }

  return false;
}

async function ensureOllamaRunning() {
  const portBusy = await isPortInUse(OLLAMA_PORT);

  if (portBusy) {
    if (await isOllamaHealthy()) {
      log('Ollama is already running on port 11434.');
      return;
    }
    throw new Error('Port 11434 is already in use by another process (not Ollama).');
  }

  if (!(await commandExists('ollama'))) {
    throw new Error('Ollama is not installed or not available in PATH.');
  }

  log('Starting Ollama server...');
  const child = spawn('ollama', ['serve'], {
    shell: true,
    windowsHide: true,
    detached: true,
    stdio: 'ignore'
  });
  child.unref();

  await waitFor(isOllamaHealthy, 30000, 1000, 'Ollama startup');
  log('Ollama server is running.');
}

async function getNgrokUrlForOllamaPort() {
  const data = await fetchJsonWithTimeout(`http://${HOST}:${NGROK_API_PORT}/api/tunnels`, 2000);
  if (!data || !Array.isArray(data.tunnels)) return null;

  const matched = data.tunnels.find((tunnel) => {
    const publicUrl = tunnel.public_url || '';
    const addr = String(tunnel?.config?.addr || '');
    return publicUrl.startsWith('https://') && addr.includes(String(OLLAMA_PORT));
  });

  return matched ? matched.public_url : null;
}

async function ensureNgrokRunning() {
  const existingUrl = await getNgrokUrlForOllamaPort();
  if (existingUrl) {
    log('Found existing ngrok tunnel for Ollama port.');
    return existingUrl;
  }

  if (!hasNgrokAuthtokenConfigured()) {
    throw new Error(
      'NGROK_AUTHTOKEN is not configured. Run: ngrok config add-authtoken <token>.'
    );
  }

  const autoNgrokPath = fs.existsSync(DEFAULT_NGROK_PATH_WINDOWS)
    ? DEFAULT_NGROK_PATH_WINDOWS
    : null;

  let ngrokCommand = process.env.NGROK_PATH || autoNgrokPath || 'ngrok';
  let ngrokArgs = ['http', String(OLLAMA_PORT)];

  const hasNgrok = process.env.NGROK_PATH
    ? fs.existsSync(process.env.NGROK_PATH)
    : await commandExists('ngrok');

  if (!hasNgrok) {
    const hasNpx = await commandExists('npx');
    if (!hasNpx) {
      throw new Error('Neither ngrok nor npx is available in PATH.');
    }
    ngrokCommand = 'npx';
    ngrokArgs = ['ngrok', 'http', String(OLLAMA_PORT)];
    log('ngrok not found globally; using npx ngrok fallback.');
  }

  log('Starting ngrok for port 11434...');
  const child = spawn(ngrokCommand, ngrokArgs, {
    shell: true,
    windowsHide: true,
    detached: true,
    stdio: 'ignore'
  });
  child.unref();

  await waitFor(
    async () => !!(await getNgrokUrlForOllamaPort()),
    30000,
    1000,
    'ngrok startup'
  );

  const ngrokUrl = await getNgrokUrlForOllamaPort();
  if (!ngrokUrl) {
    throw new Error('ngrok started but no HTTPS tunnel URL was found.');
  }

  return ngrokUrl;
}

async function ensureBackendRunning() {
  const portBusy = await isPortInUse(BACKEND_PORT);

  if (portBusy) {
    if (await isBackendHealthy()) {
      log(`Backend is already running on port ${BACKEND_PORT}.`);
      return;
    }
    throw new Error(`Port ${BACKEND_PORT} is in use by another process (backend health check failed).`);
  }

  log(`Starting backend on port ${BACKEND_PORT}...`);
  const child = spawn('npm', ['run', 'start'], {
    cwd: BACKEND_DIR,
    shell: true,
    windowsHide: true,
    detached: true,
    stdio: 'ignore'
  });
  child.unref();

  await waitFor(isBackendHealthy, 40000, 1000, 'Backend startup');
  log('Backend started successfully.');
}

function upsertEnvVar(filePath, key, value) {
  const line = `${key}=${value}`;
  const exists = fs.existsSync(filePath);
  const content = exists ? fs.readFileSync(filePath, 'utf8') : '';
  const lines = content ? content.split(/\r?\n/) : [];

  let updated = false;
  const nextLines = lines.map((l) => {
    if (l.startsWith(`${key}=`)) {
      updated = true;
      return line;
    }
    return l;
  });

  if (!updated) {
    if (nextLines.length > 0 && nextLines[nextLines.length - 1].trim() !== '') {
      nextLines.push('');
    }
    nextLines.push(line);
  }

  fs.writeFileSync(filePath, `${nextLines.join('\n')}\n`, 'utf8');
}

async function main() {
  log('Checking Ollama state...');
  await ensureOllamaRunning();

  log('Checking ngrok tunnel...');
  const ngrokUrl = await ensureNgrokRunning();

  upsertEnvVar(ENV_PATH, 'OLLAMA_API_URL', ngrokUrl);

  if (SHOULD_START_BACKEND) {
    await ensureBackendRunning();
  }

  console.log('\nOllama ngrok URL:');
  console.log(ngrokUrl);
  console.log(`\nSaved to ${ENV_PATH} as OLLAMA_API_URL`);
  if (SHOULD_START_BACKEND) {
    console.log(`Backend is up at http://${HOST}:${BACKEND_PORT}`);
  }
}

main().catch((error) => {
  console.error('\n[setup] Failed:', error.message);
  process.exit(1);
});

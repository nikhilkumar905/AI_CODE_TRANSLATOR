const LANGUAGE_MAP = {
  'c': 'C',
  'cpp': 'C++',
  'cplusplus': 'C++',
  'java': 'Java',
  'python': 'Python',
  'py': 'Python',
  'javascript': 'JavaScript',
  'js': 'JavaScript'
};

const { spawn } = require('child_process');
const path = require('path');
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS || 30000);
const TRAINED_MODEL_TIMEOUT_MS = Number(process.env.TRAINED_MODEL_TIMEOUT_MS || 60000);
const TRAINED_MODEL_WORKER_IDLE_MS = Number(process.env.TRAINED_MODEL_WORKER_IDLE_MS || 120000);
const TRAINED_MODEL_PERSISTENT = process.env.TRAINED_MODEL_PERSISTENT !== '0';
const OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || '15m';
const OLLAMA_MODEL_REFRESH_MS = Number(process.env.OLLAMA_MODEL_REFRESH_MS || 300000);
const OLLAMA_MODEL = (process.env.OLLAMA_MODEL || '').trim();

function resolveOllamaBaseUrl() {
  let base = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').trim().replace(/\/+$/, '');
  if (/^http:\/\/.+ngrok-free\.(app|dev)$/i.test(base)) {
    base = `https://${base.slice('http://'.length)}`;
  }
  return base;
}

const OLLAMA_BASE_URL = resolveOllamaBaseUrl();

// Cache for repeated conversions
const conversionCache = new Map();
const CACHE_TTL = 300000; // 5 minutes
const MAX_CACHE_ENTRIES = 200;
const inFlightConversions = new Map();

const perfMetrics = {
  startedAt: new Date().toISOString(),
  totalRequests: 0,
  successRequests: 0,
  errorRequests: 0,
  cacheHits: 0,
  inFlightHits: 0,
  pairCounts: {},
  providerCounts: {},
  durationMs: [],
  providerDurationMs: {}
};

const MAX_DURATION_SAMPLES = 1000;
let trainedModelWorker = null;
let trainedModelWorkerBuffer = '';
let trainedModelWorkerReadyPromise = null;
let trainedModelWorkerRequestId = 0;
let trainedModelWorkerIdleTimer = null;
const trainedModelWorkerPending = new Map();
let modelResolvePromise = null;
let modelCacheExpiresAt = 0;

function pushDurationSample(list, value) {
  list.push(value);
  if (list.length > MAX_DURATION_SAMPLES) {
    list.shift();
  }
}

function percentile(values, p) {
  if (!values || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function recordResult(result, elapsedMs) {
  if (result && result.success) {
    perfMetrics.successRequests += 1;
  } else {
    perfMetrics.errorRequests += 1;
  }

  const provider = (result && result.provider) ? result.provider : 'Unknown';
  perfMetrics.providerCounts[provider] = (perfMetrics.providerCounts[provider] || 0) + 1;

  pushDurationSample(perfMetrics.durationMs, elapsedMs);
  if (!perfMetrics.providerDurationMs[provider]) {
    perfMetrics.providerDurationMs[provider] = [];
  }
  pushDurationSample(perfMetrics.providerDurationMs[provider], elapsedMs);
}

function getPerformanceMetrics() {
  const total = perfMetrics.totalRequests;
  const success = perfMetrics.successRequests;
  const errors = perfMetrics.errorRequests;
  const cacheHits = perfMetrics.cacheHits;
  const inFlightHits = perfMetrics.inFlightHits;

  const durations = perfMetrics.durationMs;
  const latency = {
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    p99Ms: percentile(durations, 99),
    avgMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0,
    samples: durations.length
  };

  const providerLatency = {};
  for (const [provider, samples] of Object.entries(perfMetrics.providerDurationMs)) {
    providerLatency[provider] = {
      p50Ms: percentile(samples, 50),
      p95Ms: percentile(samples, 95),
      avgMs: samples.length ? Math.round(samples.reduce((a, b) => a + b, 0) / samples.length) : 0,
      samples: samples.length
    };
  }

  return {
    startedAt: perfMetrics.startedAt,
    now: new Date().toISOString(),
    requests: {
      total,
      success,
      errors,
      successRate: total ? Number(((success / total) * 100).toFixed(2)) : 0
    },
    acceleration: {
      cacheHits,
      cacheHitRate: total ? Number(((cacheHits / total) * 100).toFixed(2)) : 0,
      inFlightSharedHits: inFlightHits,
      inFlightSharedRate: total ? Number(((inFlightHits / total) * 100).toFixed(2)) : 0
    },
    latency,
    providers: {
      counts: perfMetrics.providerCounts,
      latencyMs: providerLatency
    },
    pairs: perfMetrics.pairCounts,
    cache: {
      entries: conversionCache.size,
      maxEntries: MAX_CACHE_ENTRIES,
      ttlMs: CACHE_TTL,
      inFlightEntries: inFlightConversions.size
    }
  };
}

function resetPerformanceMetrics() {
  perfMetrics.startedAt = new Date().toISOString();
  perfMetrics.totalRequests = 0;
  perfMetrics.successRequests = 0;
  perfMetrics.errorRequests = 0;
  perfMetrics.cacheHits = 0;
  perfMetrics.inFlightHits = 0;
  perfMetrics.pairCounts = {};
  perfMetrics.providerCounts = {};
  perfMetrics.durationMs = [];
  perfMetrics.providerDurationMs = {};
}

function normalizeCodeForCache(code) {
  return (code || '').replace(/\r\n/g, '\n').trim();
}

function cacheSet(key, value) {
  conversionCache.set(key, value);
  if (conversionCache.size > MAX_CACHE_ENTRIES) {
    // Remove oldest insertion to keep cache bounded.
    const oldestKey = conversionCache.keys().next().value;
    if (oldestKey) conversionCache.delete(oldestKey);
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = OLLAMA_TIMEOUT_MS) {
  const hostLooksLikeNgrok = /ngrok(-free)?\.(app|dev|io)/i.test(url);
  const headerBag = { ...(options.headers || {}) };
  if (hostLooksLikeNgrok && !headerBag['ngrok-skip-browser-warning']) {
    headerBag['ngrok-skip-browser-warning'] = 'true';
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, headers: headerBag, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

function estimatePredictTokens(code, source, target) {
  const normalized = code;
  const chars = normalized.length;
  const lines = normalized ? normalized.split('\n').length : 0;

  // Balanced estimate to reduce latency while preserving response completeness.
  let estimate = Math.max(Math.ceil(chars * 0.9), lines * 14, 320);

  if (source === 'cpp' && target === 'java') estimate = Math.ceil(estimate * 1.12);
  if (source === 'java' && target === 'cpp') estimate = Math.ceil(estimate * 1.08);

  return Math.max(320, Math.min(2200, estimate));
}

async function resolveOllamaModel(forceRefresh = false) {
  if (OLLAMA_MODEL) {
    warmedModel = OLLAMA_MODEL;
    modelCacheExpiresAt = Date.now() + OLLAMA_MODEL_REFRESH_MS;
    return warmedModel;
  }

  const now = Date.now();
  if (!forceRefresh && warmedModel && now < modelCacheExpiresAt) {
    return warmedModel;
  }

  if (!forceRefresh && modelResolvePromise) {
    return modelResolvePromise;
  }

  modelResolvePromise = (async () => {
    const healthCheck = await fetchWithTimeout(OLLAMA_BASE_URL + '/api/tags');
    if (!healthCheck.ok) throw new Error('Ollama not accessible');

    const modelsData = await healthCheck.json();
    const models = modelsData.models || [];
    if (models.length === 0) throw new Error('No models available');

    warmedModel = models[0].name;
    modelCacheExpiresAt = Date.now() + OLLAMA_MODEL_REFRESH_MS;
    return warmedModel;
  })();

  try {
    return await modelResolvePromise;
  } finally {
    modelResolvePromise = null;
  }
}

function normalizeLanguage(lang) {
  return LANGUAGE_MAP[lang.toLowerCase().trim()] || lang;
}

function buildPrompt(code, sourceLanguage, targetLanguage) {
  const source = sourceLanguage === 'auto' ? 'source' : normalizeLanguage(sourceLanguage);
  const target = normalizeLanguage(targetLanguage);
  const javaRules = targetLanguage.toLowerCase() === 'java'
    ? `\nJava-specific rules:\n- Use a single class named Main.\n- Do not declare methods inside main.\n- Put helper methods at class scope as static methods.\n- Put shared variables at class scope as static fields.\n- main should only initialize/call methods, not define them.\n`
    : '';

  return `Convert this ${source} code to ${target}.

Rules:
- Return only ${target} code, with no markdown fences and no explanations.
- Output must be complete and compilable.
- Preserve the original logic exactly.
- Do not omit methods, loops, conditionals, imports, or class declarations.
- Ensure all braces and blocks are balanced and closed.
${javaRules}

Source code:
${code}

${target} code:`;
}

// Simple extraction
function extractCode(text) {
  if (!text) return '';
  
  // Remove markdown code blocks
  const codeBlockMatch = text.match(/```(?:\w*)\n([\s\S]*?)\n```/);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }
  
  return text.trim();
}

function trimToBalancedJavaCode(text) {
  if (!text) return '';
  const src = text.replace(/\r\n/g, '\n');
  const classIdx = src.search(/\b(class|public\s+class)\b/);
  if (classIdx < 0) return src.trim();

  const pre = src.slice(0, classIdx);
  const imports = pre
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => /^\s*(import\s+.+;|package\s+.+;)\s*$/.test(l));

  const body = src.slice(classIdx);
  let depth = 0;
  let started = false;
  let endPos = -1;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '{') {
      depth += 1;
      started = true;
    } else if (ch === '}') {
      if (depth > 0) depth -= 1;
      if (started && depth === 0) {
        endPos = i;
        break;
      }
    }
  }

  const classBlock = endPos >= 0 ? body.slice(0, endPos + 1) : body;
  const prefix = imports.length ? `${imports.join('\n')}\n\n` : '';
  return `${prefix}${classBlock}`.trim();
}

function convertJavaHttpToCppSimple(code) {
  const urlMatch = code.match(/new\s+URL\s*\(\s*"([^"]+)"\s*\)/);
  const directUrl = urlMatch ? urlMatch[1] : null;

  const stringUrlMatch = code.match(/String\s+url\s*=\s*"([^"]+)"\s*;/);
  const fallbackUrl = stringUrlMatch ? stringUrlMatch[1] : null;

  const url = directUrl || fallbackUrl || 'https://jsonplaceholder.typicode.com/posts/1';

  return `#include <iostream>
#include <string>
#include <curl/curl.h>

using namespace std;

size_t writeCallback(void* contents, size_t size, size_t nmemb, string* output) {
    size_t totalSize = size * nmemb;
    output->append(static_cast<char*>(contents), totalSize);
    return totalSize;
}

int main() {
    CURL* curl = curl_easy_init();
    CURLcode res;
    string response;

    if (curl) {
        curl_easy_setopt(curl, CURLOPT_URL, "${url}");
        curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, writeCallback);
        curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response);

        res = curl_easy_perform(curl);

        if (res != CURLE_OK) {
            cout << "Error: " << curl_easy_strerror(res) << endl;
        } else {
            cout << "Response:" << endl;
            cout << response << endl;
        }

        curl_easy_cleanup(curl);
    }

    return 0;
}`;
}

function isJavaHttpGetPattern(code) {
  return /new\s+URL\s*\(/.test(code) && /openStream\s*\(/.test(code);
}

function convertCppToJavaSimple(code) {
  const lines = code.split('\n');

  const typeMap = {
    bool: 'boolean',
    void: 'void',
    int: 'int',
    double: 'double',
    float: 'float',
    string: 'String',
    char: 'char'
  };

  function convertParams(params) {
    const p = params.trim();
    if (!p) return '';
    return p
      .split(',')
      .map((part) => part.trim().replace(/\s+/g, ' '))
      .map((part) => {
        const m = part.match(/^(int|bool|double|float|string|char|auto)\s+(.+)$/i);
        if (!m) return part;
        const t = (typeMap[m[1].toLowerCase()] || m[1]);
        return `${t} ${m[2].trim()}`;
      })
      .join(', ');
  }

  function convertCout(line) {
    const t = line.trim();
    if (!t.startsWith('cout <<')) return line;

    const isPrintln = /<<\s*endl\s*;\s*$/.test(t);
    let expr = t.replace(/^cout\s*<<\s*/, '').replace(/;\s*$/, '');
    expr = expr.replace(/<<\s*endl\s*$/,'').trim();
    const parts = expr.split('<<').map((s) => s.trim()).filter(Boolean);
    const joined = parts.join(' + ');
    return isPrintln
      ? line.replace(/cout\s*<<[\s\S]*;\s*$/, `System.out.println(${joined});`)
      : line.replace(/cout\s*<<[\s\S]*;\s*$/, `System.out.print(${joined});`);
  }

  function convertGlobalExpr(expr) {
    let out = expr.trim();
    out = out.replace(/\btrue\b/g, 'true').replace(/\bfalse\b/g, 'false');
    return out;
  }

  // Parse top-level global fields only (brace depth = 0).
  const fieldDecls = [];
  let depth = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      depth += (raw.match(/\{/g) || []).length;
      depth -= (raw.match(/\}/g) || []).length;
      continue;
    }

    if (depth === 0) {
      const vec2 = line.match(/^vector\s*<\s*vector\s*<\s*int\s*>\s*>\s+(\w+)\s*\(\s*([^,]+)\s*,\s*vector\s*<\s*int\s*>\s*\(\s*([^,\)]+)\s*,\s*[^\)]+\)\s*\)\s*;$/);
      if (vec2) {
        const name = vec2[1];
        const rows = convertGlobalExpr(vec2[2]);
        const cols = convertGlobalExpr(vec2[3]);
        fieldDecls.push(`static int[][] ${name} = new int[${rows}][${cols}];`);
      } else {
        const simple = line.match(/^(int|bool|double|float|string|char)\s+(\w+)\s*=\s*(.+);$/i);
        if (simple) {
          const jType = typeMap[simple[1].toLowerCase()] || simple[1];
          const name = simple[2];
          const value = convertGlobalExpr(simple[3]);
          fieldDecls.push(`static ${jType} ${name} = ${value};`);
        }
      }
    }

    depth += (raw.match(/\{/g) || []).length;
    depth -= (raw.match(/\}/g) || []).length;
  }

  function convertBodyLine(line, isMain) {
    const indent = (line.match(/^\s*/) || [''])[0];
    let t = line.trim();
    if (!t) return line;

    t = t.replace(/\bauto\s+(\w+)\s*=\s*/g, 'int $1 = ');
    if (t.startsWith('return 0;') && isMain) return null;
    if (t.startsWith('using namespace')) return null;
    if (t.startsWith('#include')) return null;

    const converted = convertCout(indent + t);
    return converted;
  }

  // Parse top-level C++ functions.
  const methods = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.trim().match(/^(bool|void|int|double|float|string|char)\s+(\w+)\(([^)]*)\)\s*\{\s*$/i);
    if (!m) continue;

    const retRaw = m[1].toLowerCase();
    const name = m[2];
    const params = convertParams(m[3]);

    let braceDepth = 0;
    const body = [];
    for (; i < lines.length; i++) {
      const cur = lines[i];
      braceDepth += (cur.match(/\{/g) || []).length;
      braceDepth -= (cur.match(/\}/g) || []).length;

      if (cur !== line) body.push(cur);
      if (braceDepth === 0) break;
    }

    // Remove trailing closing brace line from body.
    if (body.length > 0 && body[body.length - 1].trim() === '}') {
      body.pop();
    }

    methods.push({ retRaw, name, params, body });
  }

  const out = [];
  out.push('import java.util.*;');
  out.push('');
  out.push('public class Main {');

  for (const decl of fieldDecls) {
    out.push(`    ${decl}`);
  }
  if (fieldDecls.length > 0) out.push('');

  for (const method of methods) {
    const isMain = method.name === 'main' && method.retRaw === 'int';
    if (isMain) {
      out.push('    public static void main(String[] args) {');
    } else {
      const ret = typeMap[method.retRaw] || method.retRaw;
      out.push(`    static ${ret} ${method.name}(${method.params}) {`);
    }

    for (const b of method.body) {
      const converted = convertBodyLine(b, isMain);
      if (converted === null) continue;
      out.push(`    ${converted}`);
    }
    out.push('    }');
    out.push('');
  }

  out.push('}');
  return out.join('\n');
}

function isRuleBasedCppToJavaSafe(code) {
  // Rule-based path handles simple algorithmic C++ only.
  // For external/native APIs and pointer-heavy code, fall back to LLM.
  if (/#include\s*<\s*curl\/curl\.h\s*>/i.test(code)) return false;
  if (/\bCURL\s*\*/.test(code)) return false;
  if (/\bCURLcode\b/.test(code)) return false;
  if (/\bcurl_easy_\w+\s*\(/.test(code)) return false;
  if (/\bvoid\s*\*/.test(code)) return false;
  return true;
}

// Call local trained model service for Python<->C++ only
function callTrainedModelServiceOneShot(code, sourceLang, targetLang) {
  return new Promise((resolve, reject) => {
    const pythonPath = process.env.PYTHON_EXECUTABLE || 'python';
    const scriptPath = path.join(__dirname, 'trainedModelService.py');
    const defaultModelPath = path.resolve(__dirname, '..', '..', '..', 'Model');
    const modelPath = process.env.TRAINED_MODEL_PATH || defaultModelPath;
    
    console.log(`Starting trained model service: ${pythonPath} ${scriptPath}`);
    
    const child = spawn(pythonPath, [scriptPath, modelPath, sourceLang, targetLang], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });
    
    // Write code to stdin
    child.stdin.write(code);
    child.stdin.end();
    
    let stdout = '';
    let stderr = '';
    
    child.stdout.on('data', (data) => {
      stdout += data.toString();
      console.log('FT stdout:', data.toString().substring(0, 100));
    });
    
    child.stderr.on('data', (data) => {
      stderr += data.toString();
      console.error('FT stderr:', data.toString().substring(0, 100));
    });
    
    child.on('close', (code) => {
      console.log(`FT process exited with code ${code}`);
      if (code === 0) {
        try {
          const result = JSON.parse(stdout.trim());
          resolve(result);
        } catch (e) {
          console.error('JSON parse error:', e.message, 'stdout:', stdout);
          reject(new Error('Invalid JSON from trained model service'));
        }
      } else {
        reject(new Error(`Trained model service failed (exit ${code}): ${stderr}`));
      }
    });
    
    child.on('error', (err) => {
      reject(new Error(`Failed to start trained model service: ${err.message}`));
    });

    const timeoutId = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch (_err) {
        // ignore kill errors
      }
      reject(new Error(`Trained model service timed out after ${TRAINED_MODEL_TIMEOUT_MS}ms`));
    }, TRAINED_MODEL_TIMEOUT_MS);

    child.on('exit', () => {
      clearTimeout(timeoutId);
    });
  });
}

function scheduleTrainedWorkerIdleStop() {
  if (trainedModelWorkerIdleTimer) {
    clearTimeout(trainedModelWorkerIdleTimer);
  }
  trainedModelWorkerIdleTimer = setTimeout(() => {
    if (trainedModelWorker && trainedModelWorkerPending.size === 0) {
      try {
        trainedModelWorker.kill('SIGTERM');
      } catch (_err) {
        // ignore kill errors
      }
    }
  }, TRAINED_MODEL_WORKER_IDLE_MS);
}

function cleanupTrainedWorker() {
  if (trainedModelWorkerIdleTimer) {
    clearTimeout(trainedModelWorkerIdleTimer);
    trainedModelWorkerIdleTimer = null;
  }
  const pending = Array.from(trainedModelWorkerPending.values());
  trainedModelWorkerPending.clear();
  for (const p of pending) {
    p.reject(new Error('Trained model worker stopped unexpectedly'));
  }
  trainedModelWorker = null;
  trainedModelWorkerBuffer = '';
  trainedModelWorkerReadyPromise = null;
}

function handleTrainedWorkerMessage(message) {
  if (message && message.type === 'ready') {
    return;
  }
  const id = message && message.id;
  if (!id || !trainedModelWorkerPending.has(id)) {
    return;
  }
  const pending = trainedModelWorkerPending.get(id);
  trainedModelWorkerPending.delete(id);

  if (message.success) {
    pending.resolve({
      success: true,
      convertedCode: message.convertedCode,
      provider: message.provider || 'Local Trained Model (Python<->C++)'
    });
  } else {
    pending.reject(new Error(message.error || 'Trained model worker request failed'));
  }
}

function getTrainedModelWorker() {
  if (trainedModelWorkerReadyPromise) {
    return trainedModelWorkerReadyPromise;
  }

  trainedModelWorkerReadyPromise = new Promise((resolve, reject) => {
    const pythonPath = process.env.PYTHON_EXECUTABLE || 'python';
    const scriptPath = path.join(__dirname, 'trainedModelService.py');
    const defaultModelPath = path.resolve(__dirname, '..', '..', '..', 'Model');
    const modelPath = process.env.TRAINED_MODEL_PATH || defaultModelPath;

    const child = spawn(pythonPath, [scriptPath, '--worker', modelPath], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });

    let stderr = '';
    const startupTimeoutId = setTimeout(() => {
      reject(new Error(`Trained model worker startup timed out after ${TRAINED_MODEL_TIMEOUT_MS}ms`));
      try {
        child.kill('SIGTERM');
      } catch (_err) {
        // ignore kill errors
      }
    }, TRAINED_MODEL_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      trainedModelWorkerBuffer += chunk.toString();
      const lines = trainedModelWorkerBuffer.split(/\r?\n/);
      trainedModelWorkerBuffer = lines.pop() || '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        let msg;
        try {
          msg = JSON.parse(line);
        } catch (_err) {
          continue;
        }

        if (msg.type === 'ready' && msg.success) {
          clearTimeout(startupTimeoutId);
          trainedModelWorker = child;
          scheduleTrainedWorkerIdleStop();
          resolve(child);
          continue;
        }

        handleTrainedWorkerMessage(msg);
      }
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('error', (err) => {
      clearTimeout(startupTimeoutId);
      reject(new Error(`Failed to start trained model worker: ${err.message}`));
      cleanupTrainedWorker();
    });

    child.on('exit', () => {
      clearTimeout(startupTimeoutId);
      cleanupTrainedWorker();
    });
  });

  return trainedModelWorkerReadyPromise;
}

async function callTrainedModelServicePersistent(code, sourceLang, targetLang) {
  const worker = await getTrainedModelWorker();
  scheduleTrainedWorkerIdleStop();

  const requestId = `req-${Date.now()}-${++trainedModelWorkerRequestId}`;
  const payload = JSON.stringify({
    id: requestId,
    code,
    source_lang: sourceLang,
    target_lang: targetLang
  });

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      trainedModelWorkerPending.delete(requestId);
      reject(new Error(`Trained model service timed out after ${TRAINED_MODEL_TIMEOUT_MS}ms`));
    }, TRAINED_MODEL_TIMEOUT_MS);

    trainedModelWorkerPending.set(requestId, {
      resolve: (value) => {
        clearTimeout(timeoutId);
        resolve(value);
      },
      reject: (err) => {
        clearTimeout(timeoutId);
        reject(err);
      }
    });

    try {
      worker.stdin.write(`${payload}\n`);
    } catch (err) {
      trainedModelWorkerPending.delete(requestId);
      clearTimeout(timeoutId);
      reject(new Error(`Failed to send request to trained model worker: ${err.message}`));
    }
  });
}

async function callTrainedModelService(code, sourceLang, targetLang) {
  if (!TRAINED_MODEL_PERSISTENT) {
    return callTrainedModelServiceOneShot(code, sourceLang, targetLang);
  }

  try {
    return await callTrainedModelServicePersistent(code, sourceLang, targetLang);
  } catch (err) {
    console.warn(`Persistent trained model worker failed, falling back to one-shot: ${err.message}`);
    return callTrainedModelServiceOneShot(code, sourceLang, targetLang);
  }
}

// Call Python Hugging Face service
function callHFService(code, sourceLang, targetLang) {
  return new Promise((resolve, reject) => {
    const pythonPath = 'python';
    const scriptPath = path.join(__dirname, 'hfTranslationService.py');
    
    console.log(`Starting HF service: ${pythonPath} ${scriptPath}`);
    
    const child = spawn(pythonPath, [scriptPath, code, sourceLang, targetLang], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });
    
    let stdout = '';
    let stderr = '';
    
    child.stdout.on('data', (data) => {
      stdout += data.toString();
      console.log('HF stdout:', data.toString().substring(0, 100));
    });
    
    child.stderr.on('data', (data) => {
      stderr += data.toString();
      console.error('HF stderr:', data.toString().substring(0, 100));
    });
    
    child.on('close', (code) => {
      console.log(`HF process exited with code ${code}`);
      if (code === 0) {
        try {
          const result = JSON.parse(stdout.trim());
          resolve(result);
        } catch (e) {
          console.error('JSON parse error:', e.message, 'stdout:', stdout);
          reject(new Error('Invalid JSON from Hugging Face service'));
        }
      } else {
        reject(new Error(`Hugging Face service failed (exit ${code}): ${stderr}`));
      }
    });
    
    child.on('error', (err) => {
      reject(new Error(`Failed to start Hugging Face service: ${err.message}`));
    });
  });
}


// Warm up model on startup
let warmedModel = null;
async function warmModel() {
  try {
    warmedModel = await resolveOllamaModel(true);
    console.log('Warmed model:', warmedModel);
    
    // Quick warmup
    await fetchWithTimeout(OLLAMA_BASE_URL + '/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: warmedModel,
        prompt: '1+1',
        stream: false,
        keep_alive: OLLAMA_KEEP_ALIVE,
        options: { num_predict: 5 }
      })
    });
  } catch (err) {
    console.log('Warm-up failed:', err.message);
  }
}

// Start warming immediately
warmModel();

async function convertCode(code, sourceLanguage, targetLanguage) {
  const requestStart = Date.now();
  const source = sourceLanguage.toLowerCase();
  const target = targetLanguage.toLowerCase();
  const normalizedCode = normalizeCodeForCache(code);
  const pairKey = `${source}->${target}`;

  perfMetrics.totalRequests += 1;
  perfMetrics.pairCounts[pairKey] = (perfMetrics.pairCounts[pairKey] || 0) + 1;

  // Fast path: no conversion needed.
  if (source === target) {
    const identityResult = {
      success: true,
      convertedCode: code,
      provider: 'Identity Converter',
      conversionTime: '0.0s'
    };
    recordResult(identityResult, Date.now() - requestStart);
    return identityResult;
  }

  // Cache key
  const cacheKey = `${source}:${target}:${normalizedCode}`;
  const cached = conversionCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    const cachedResult = {
      success: true,
      convertedCode: cached.result,
      provider: `${cached.provider || 'Translator'} (Cached)`,
      conversionTime: '0.0s'
    };
    perfMetrics.cacheHits += 1;
    recordResult(cachedResult, Date.now() - requestStart);
    return cachedResult;
  }

  // Deduplicate concurrent identical conversions.
  const inFlight = inFlightConversions.get(cacheKey);
  if (inFlight) {
    perfMetrics.inFlightHits += 1;
    const sharedResult = await inFlight;
    recordResult(sharedResult, Date.now() - requestStart);
    return sharedResult;
  }

  const conversionPromise = (async () => {
  
    // Python <-> C++ is handled only by the trained local model
    if ((source === 'python' && target === 'cpp') ||
        (source === 'cpp' && target === 'python')) {
      const startTime = Date.now();
      try {
        console.log('Using trained model converter for', source, '->', target);
        const result = await callTrainedModelService(code, source, target);

        if (result.success) {
          cacheSet(cacheKey, {
            result: result.convertedCode,
            provider: result.provider || 'Local Trained Model',
            timestamp: Date.now()
          });
          const duration = ((Date.now() - startTime) / 1000).toFixed(1);

          return {
            success: true,
            convertedCode: result.convertedCode,
            provider: result.provider || 'Local Trained Model',
            conversionTime: `${duration}s`
          };
        }
      } catch (err) {
        return {
          success: false,
          error: err.message
        };
      }

      return {
        success: false,
        error: 'Trained model conversion failed'
      };
    }

    // Use deterministic conversion for C++ -> Java to avoid malformed LLM structures.
    if (source === 'cpp' && target === 'java') {
      if (isRuleBasedCppToJavaSafe(code)) {
        try {
          const convertedCode = convertCppToJavaSimple(code);
          cacheSet(cacheKey, {
            result: convertedCode,
            provider: 'Rule-Based C++-Java Converter',
            timestamp: Date.now()
          });
          return {
            success: true,
            convertedCode,
            provider: 'Rule-Based C++-Java Converter',
            conversionTime: '0.0s'
          };
        } catch (err) {
          // Fall back to LLM path on unexpected parsing errors.
          console.warn('Rule-based cpp->java fallback to LLM:', err.message);
        }
      }
    }

    // Deterministic reverse mapping for common Java URL/openStream HTTP code -> C++ libcurl.
    if (source === 'java' && target === 'cpp' && isJavaHttpGetPattern(code)) {
      const convertedCode = convertJavaHttpToCppSimple(code);
      cacheSet(cacheKey, {
        result: convertedCode,
        provider: 'Rule-Based Java-C++ HTTP Converter',
        timestamp: Date.now()
      });
      return {
        success: true,
        convertedCode,
        provider: 'Rule-Based Java-C++ HTTP Converter',
        conversionTime: '0.0s'
      };
    }
  
    // Use LLM for all other language pairs
    const prompt = buildPrompt(code, sourceLanguage, targetLanguage);

    try {
      const startTime = Date.now();
    
      // Resolve model with shared in-flight promise to avoid repeated /api/tags lookups.
      const model = await resolveOllamaModel();
    
      const estimatedPredict = estimatePredictTokens(normalizedCode, source, target);

      const response = await fetchWithTimeout(OLLAMA_BASE_URL + '/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model,
        prompt: prompt,
        stream: false,
          keep_alive: OLLAMA_KEEP_ALIVE,
          options: {
            temperature: 0.0,
            num_predict: estimatedPredict,
            top_p: 0.9,
            repeat_penalty: 1.05,
            num_ctx: 2048,
            num_batch: 8
          }
      })
      });

      if (!response.ok) {
        throw new Error(`Ollama error: ${response.status}`);
      }

      const data = await response.json();
      if (!data.response) throw new Error('Invalid response');

      let convertedCode = extractCode(data.response).trim();

      if (target === 'java') {
        convertedCode = trimToBalancedJavaCode(convertedCode);
      }

      // Basic validation
      if (!convertedCode || convertedCode.length < 5) {
        throw new Error('Generated response is too short');
      }

      // Cache result
      cacheSet(cacheKey, {
        result: convertedCode,
        provider: `Ollama (${model})`,
        timestamp: Date.now()
      });

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);

      return {
        success: true,
        convertedCode,
        provider: `Ollama (${model})`,
        conversionTime: `${duration}s`
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  })();

  inFlightConversions.set(cacheKey, conversionPromise);
  try {
    const result = await conversionPromise;
    recordResult(result, Date.now() - requestStart);
    return result;
  } finally {
    inFlightConversions.delete(cacheKey);
  }
}

module.exports = {
  convertCode,
  normalizeLanguage,
  getPerformanceMetrics,
  resetPerformanceMetrics
};

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
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS || 45000);
const TRAINED_MODEL_TIMEOUT_MS = Number(process.env.TRAINED_MODEL_TIMEOUT_MS || 240000);
const TRAINED_MODEL_WORKER_IDLE_MS = Number(process.env.TRAINED_MODEL_WORKER_IDLE_MS || 120000);
const TRAINED_MODEL_PERSISTENT = process.env.TRAINED_MODEL_PERSISTENT !== '0';
const OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || '15m';
const OLLAMA_MODEL_REFRESH_MS = Number(process.env.OLLAMA_MODEL_REFRESH_MS || 300000);
const OLLAMA_MAX_TIMEOUT_MS = Number(process.env.OLLAMA_MAX_TIMEOUT_MS || 360000);
const OLLAMA_MODEL = (process.env.OLLAMA_MODEL || '').trim();

function resolveOllamaBaseUrl() {
  return (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').trim().replace(/\/+$/, '');
}

const OLLAMA_BASE_URL = resolveOllamaBaseUrl();

function buildOllamaUnavailableResult(details) {
  return {
    success: false,
    errorCode: 'OLLAMA_NOT_AVAILABLE',
    error: 'Ollama is not available on this server. Download and run Ollama first, then try again.',
    details
  };
}

function isOllamaUnavailableError(err) {
  const msg = (err && err.message ? err.message : String(err || '')).toLowerCase();
  return (
    msg.includes('failed to fetch') ||
    msg.includes('fetch failed') ||
    msg.includes('econnrefused') ||
    msg.includes('connect') ||
    msg.includes('ollama not accessible') ||
    msg.includes('no models available') ||
    msg.includes('ollama error: 404') ||
    msg.includes('ollama error: 500') ||
    msg.includes('aborterror')
  );
}

// Cache for repeated conversions
const conversionCache = new Map();
const CACHE_TTL = 300000; // 5 minutes
const MAX_CACHE_ENTRIES = 200;
const CACHE_SCHEMA_VERSION = 'v11';
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
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new Error(`Ollama request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function computeOllamaTimeoutMs(prompt, estimatedPredict) {
  const byPromptSize = Math.ceil((prompt.length || 0) * 2.2);
  const byOutputSize = Math.ceil((estimatedPredict || 0) * 220);
  const dynamicTimeout = Math.max(OLLAMA_TIMEOUT_MS, 60000 + byPromptSize + byOutputSize);
  return Math.min(OLLAMA_MAX_TIMEOUT_MS, dynamicTimeout);
}

async function generateWithOllama(prompt, model, estimatedPredict) {
  const requestTimeoutMs = computeOllamaTimeoutMs(prompt, estimatedPredict);

  // Prefer classic Ollama endpoint.
  const generateResponse = await fetchWithTimeout(OLLAMA_BASE_URL + '/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
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
  }, requestTimeoutMs);

  if (generateResponse.ok) {
    const data = await generateResponse.json();
    if (!data.response) {
      throw new Error('Invalid response');
    }
    return data.response;
  }

  // Some local Ollama setups expose only OpenAI-compatible endpoints.
  if (generateResponse.status === 404) {
    const chatResponse = await fetchWithTimeout(OLLAMA_BASE_URL + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.0,
        max_tokens: estimatedPredict,
        stream: false
      })
    }, requestTimeoutMs);

    if (!chatResponse.ok) {
      throw new Error(`Ollama error: ${chatResponse.status}`);
    }

    const data = await chatResponse.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content || typeof content !== 'string') {
      throw new Error('Invalid chat response');
    }
    return content;
  }

  throw new Error(`Ollama error: ${generateResponse.status}`);
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

function detectSourceLanguageFromCode(code) {
  const sample = String(code || '');

  const cppSignals = [
    /#include\s*</,
    /\busing\s+namespace\s+std\b/,
    /\bstd::/,
    /->/,
    /\bcout\s*<</,
    /\bint\s+main\s*\(/,
    /;\s*$/m
  ];

  const pythonSignals = [
    /^\s*def\s+\w+\s*\(/m,
    /^\s*class\s+\w+\s*:/m,
    /^\s*import\s+\w+/m,
    /\bself\./,
    /print\s*\(/
  ];

  const cppScore = cppSignals.reduce((score, rule) => score + (rule.test(sample) ? 1 : 0), 0);
  const pyScore = pythonSignals.reduce((score, rule) => score + (rule.test(sample) ? 1 : 0), 0);

  if (cppScore >= 2 && cppScore >= pyScore) return 'cpp';
  if (pyScore >= 2 && pyScore > cppScore) return 'python';
  return 'auto';
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
  const javaStartIdx = src.search(/^\s*(package\s+.+;|import\s+.+;|public\s+class\s+\w+\s*\{|class\s+\w+\s*\{|public\s+interface\s+\w+\s*\{|interface\s+\w+\s*\{|public\s+enum\s+\w+\s*\{|enum\s+\w+\s*\{)/m);
  if (javaStartIdx < 0) return src.trim();
  return src.slice(javaStartIdx).trim();
}

function trimForeignTailForJava(text) {
  if (!text) return '';
  const markers = [
    /^\s*class\s+\w+\s*:\s*$/m,
    /^\s*def\s+\w+\s*\(/m,
    /^\s*if\s+__name__\s*==\s*["']__main__["']\s*:/m,
    /^\s*import\s+[a-zA-Z_][a-zA-Z0-9_]*\s*$/m
  ];

  let cutAt = -1;
  for (const marker of markers) {
    const match = marker.exec(text);
    if (match && match.index > 0) {
      cutAt = cutAt < 0 ? match.index : Math.min(cutAt, match.index);
    }
  }

  return cutAt >= 0 ? text.slice(0, cutAt).trim() : text.trim();
}

function trimForeignTailForPython(text) {
  if (!text) return '';
  const markers = [
    /^\s*import\s+java\.[^\n]+$/m,
    /^\s*public\s+class\s+\w+\s*\{/m,
    /^\s*class\s+\w+\s*\{\s*$/m,
    /^\s*public\s+static\s+void\s+main\s*\(/m,
    /#include\s*</,
    /^\s*using\s+namespace\s+\w+\s*;/m,
    /^\s*(?:int|void|double|float|bool|string|char)\s+main\s*\(/m
  ];

  let cutAt = -1;
  for (const marker of markers) {
    const match = marker.exec(text);
    if (match && match.index > 0) {
      cutAt = cutAt < 0 ? match.index : Math.min(cutAt, match.index);
    }
  }

  return cutAt >= 0 ? text.slice(0, cutAt).trim() : text.trim();
}

function trimLeadingNonPythonForPythonTarget(text) {
  if (!text) return '';
  const startMarker = /^\s*(from\s+\w+\s+import\s+\w+|import\s+\w+|class\s+\w+\s*:|def\s+\w+\s*\(|if\s+__name__\s*==\s*["']__main__["']\s*:)/m;
  const match = startMarker.exec(text);
  if (match && match.index > 0) {
    return text.slice(match.index).trim();
  }
  return text.trim();
}

function stripInterleavedCppFromPython(text) {
  if (!text) return '';

  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const filtered = [];

  for (const raw of lines) {
    const line = raw;
    const trimmed = line.trim();

    if (!trimmed) {
      filtered.push('');
      continue;
    }

    // Drop obvious C/C++ artifacts that can leak into mixed responses.
    if (
      /^#include\s*</.test(trimmed) ||
      /^using\s+namespace\s+\w+\s*;?$/.test(trimmed) ||
      /^(?:public|private|protected)\s*:\s*$/.test(trimmed) ||
      /^\{\s*$/.test(trimmed) ||
      /^\}\s*;?\s*$/.test(trimmed) ||
      /^int\s+main\s*\(/.test(trimmed) ||
      /^\w+\s*::\s*\w+\s*\(/.test(trimmed)
    ) {
      continue;
    }

    // Drop C++-style function signatures while preserving Python def lines.
    if (
      /^(?:const\s+)?(?:unsigned\s+)?(?:long\s+)?(?:int|void|double|float|bool|string|char|auto)\s+\w+\s*\([^)]*\)\s*\{?\s*$/.test(trimmed)
    ) {
      continue;
    }

    // Drop lines containing strongly C++-specific syntax/tokens.
    if (
      /(\bstd::|\bcin\b|\bcout\b|\bvector\s*<|->|\bendl\b)/.test(trimmed) ||
      /;\s*$/.test(trimmed)
    ) {
      continue;
    }

    filtered.push(line);
  }

  const compact = filtered.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return compact;
}

function sanitizeConvertedOutput(text, target) {
  const normalizedTarget = (target || '').toLowerCase();
  let output = (text || '').trim();

  if (normalizedTarget === 'java') {
    output = trimToBalancedJavaCode(output);
    output = trimForeignTailForJava(output);
  } else if (normalizedTarget === 'python') {
    output = trimLeadingNonPythonForPythonTarget(output);
    output = stripInterleavedCppFromPython(output);
    output = trimForeignTailForPython(output);
    output = repairPythonFromCppArtifacts(output);
  } else if (normalizedTarget === 'cpp') {
    output = trimForeignTailForCpp(output);
    output = repairCppFromPythonArtifacts(output);
  }

  return output;
}

function repairPythonFromCppArtifacts(text) {
  let out = String(text || '');

  // Common C++ STL idioms that occasionally leak into python output.
  out = out.replace(
    /\*\s*max_element\(\s*([A-Za-z_]\w*)\.begin\(\)\s*,\s*\1\.end\(\)\s*\)/g,
    'max($1)'
  );

  // LeetCode-style integer binary search midpoint should stay integer.
  out = out.replace(
    /^([ \t]*mid\s*=\s*\([^\n]*left[^\n]*right[^\n]*\))\s*\/\s*2\s*$/gm,
    '$1 // 2'
  );

  // Integer ceil-division pattern used in Koko/minEatingSpeed style code.
  out = out.replace(
    /^([ \t]*hours\s*\+=\s*\([^\n]*\))\s*\/\s*([A-Za-z_]\w+)\s*$/gm,
    '$1 // $2'
  );

  out = out.replace(/\btrue\b/g, 'True').replace(/\bfalse\b/g, 'False');
  return out;
}

function trimForeignTailForCpp(text) {
  if (!text) return '';
  const markers = [
    /^\s*from\s+\w+\s+import\s+\w+/m,
    /^\s*import\s+\w+/m,
    /^\s*def\s+\w+\s*\(/m,
    /^\s*if\s+__name__\s*==\s*["']__main__["']\s*:/m
  ];

  let cutAt = -1;
  for (const marker of markers) {
    const match = marker.exec(text);
    if (match && match.index > 0) {
      cutAt = cutAt < 0 ? match.index : Math.min(cutAt, match.index);
    }
  }

  return cutAt >= 0 ? text.slice(0, cutAt).trim() : text.trim();
}

function repairCppFromPythonArtifacts(text) {
  let out = String(text || '');
  out = out.replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false');
  return out;
}

function normalizePythonInputForModel(code) {
  let out = String(code || '');

  // Common typo in main guard: `if __name__ = "__main__":`
  out = out.replace(
    /^([ \t]*if[ \t]+__name__[ \t]*)=(?!=)([ \t]*["']__main__["'][ \t]*:)/gm,
    '$1==$2'
  );

  return out;
}

function shouldRetryModelOutput(code, target) {
  const output = String(code || '');
  if (!output.trim()) return true;

  const unsupportedMarkers = [
    'Unsupported Python statement',
    '/* unsupported_expr */'
  ];

  if (unsupportedMarkers.some((marker) => output.includes(marker))) {
    return true;
  }

  if (target === 'python') {
    const cppLeakMarkers = [
      '#include <',
      'using namespace std',
      'int main(',
      '*max_element(',
      '.begin()',
      '.end()'
    ];
    return cppLeakMarkers.some((marker) => output.includes(marker));
  }

  if (target === 'cpp') {
    const pythonLeakMarkers = [
      'def ',
      'if __name__ == "__main__":',
      'if __name__ == \"__main__\":',
      'print(',
      'deque('
    ];
    return pythonLeakMarkers.some((marker) => output.includes(marker));
  }

  return false;
}

async function callTrainedModelWithFallback(code, sourceLang, targetLang) {
  const normalizedCode = sourceLang === 'python' ? normalizePythonInputForModel(code) : code;
  let firstErr = null;

  try {
    const primary = await callTrainedModelService(normalizedCode, sourceLang, targetLang);
    const cleanedPrimary = sanitizeConvertedOutput(primary.convertedCode, targetLang);
    if (!shouldRetryModelOutput(cleanedPrimary, targetLang)) {
      return {
        success: true,
        convertedCode: cleanedPrimary,
        provider: primary.provider || 'Local Trained Model (Python<->C++)'
      };
    }
  } catch (err) {
    firstErr = err;
  }

  // Fallback: retry with one-shot process (still model-based, no Ollama fallback).
  const retry = await callTrainedModelServiceOneShot(normalizedCode, sourceLang, targetLang);
  const cleanedRetry = sanitizeConvertedOutput(retry.convertedCode, targetLang);
  if (shouldRetryModelOutput(cleanedRetry, targetLang)) {
    throw new Error(firstErr ? `Model fallback failed: ${firstErr.message}` : 'Model fallback failed: invalid conversion output');
  }

  return {
    success: true,
    convertedCode: cleanedRetry,
    provider: `${retry.provider || 'Local Trained Model (Python<->C++)'} (Fallback)`
  };
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

  return callTrainedModelServicePersistent(code, sourceLang, targetLang);
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
    await generateWithOllama('1+1', warmedModel, 5);
  } catch (err) {
    console.log('Warm-up failed:', err.message);
  }
}

// Start warming immediately
warmModel();

async function convertCode(code, sourceLanguage, targetLanguage) {
  const requestStart = Date.now();
  const requestedSource = sourceLanguage.toLowerCase();
  const detectedSource = requestedSource === 'auto' ? detectSourceLanguageFromCode(code) : requestedSource;
  const source = detectedSource;
  const target = targetLanguage.toLowerCase();
  const inferredFromCode = detectSourceLanguageFromCode(code);
  const looksLikeCpp = inferredFromCode === 'cpp';
  const looksLikePython = inferredFromCode === 'python';
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
  const cacheKey = `${CACHE_SCHEMA_VERSION}:${source}:${target}:${normalizedCode}`;
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
    if (((source === 'python' || looksLikePython) && target === 'cpp') ||
        ((source === 'cpp' || looksLikeCpp) && target === 'python')) {
      const startTime = Date.now();
      const effectiveSource = (inferredFromCode === 'python' || inferredFromCode === 'cpp')
        ? inferredFromCode
        : source;

      try {
        // If code already matches target, avoid unnecessary conversion that can degrade output.
        if (effectiveSource === target) {
          const identityResult = {
            success: true,
            convertedCode: code,
            provider: `Identity Converter (Detected ${effectiveSource})`,
            conversionTime: '0.0s'
          };

          cacheSet(cacheKey, {
            result: identityResult.convertedCode,
            provider: identityResult.provider,
            timestamp: Date.now()
          });

          return identityResult;
        }

        console.log('Using trained model converter for', effectiveSource, '->', target);
        const result = await callTrainedModelWithFallback(code, effectiveSource, target);

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
          error: err.message || 'Trained model conversion failed'
        };
      }
    }

    // Use Ollama for all language pairs except Python<->C++.
    const prompt = buildPrompt(code, source, targetLanguage);

    try {
      const startTime = Date.now();
    
      // Resolve model with shared in-flight promise to avoid repeated /api/tags lookups.
      const model = await resolveOllamaModel();
    
      const estimatedPredict = estimatePredictTokens(normalizedCode, source, target);

      const rawResponse = await generateWithOllama(prompt, model, estimatedPredict);

      let convertedCode = sanitizeConvertedOutput(extractCode(rawResponse), target);

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
      if (isOllamaUnavailableError(error)) {
        return buildOllamaUnavailableResult(error.message);
      }

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

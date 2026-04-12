function byId(id) {
  return document.getElementById(id);
}

function nowMs() {
  return performance.now();
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function tokenize(text) {
  return (text || "")
    .toLowerCase()
    .replace(/\r\n/g, "\n")
    .replace(/[^a-z0-9_\n]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function jaccardSimilarity(a, b) {
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  if (!sa.size && !sb.size) return 100;
  const intersection = [...sa].filter((x) => sb.has(x)).length;
  const union = new Set([...sa, ...sb]).size;
  return Number(((intersection / union) * 100).toFixed(2));
}

async function convertOnce({ backendUrl, code, sourceLanguage, targetLanguage }) {
  const start = nowMs();
  const resp = await fetch(`${backendUrl}/api/convert`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, sourceLanguage, targetLanguage })
  });
  const elapsedMs = nowMs() - start;
  const data = await resp.json().catch(() => ({}));
  return {
    elapsedMs: Number(elapsedMs.toFixed(2)),
    ok: resp.ok && data.success,
    status: resp.status,
    provider: data.provider || "Unknown",
    convertedCode: data.convertedCode || "",
    error: data.error || (!resp.ok ? `HTTP ${resp.status}` : "")
  };
}

async function runBenchmark() {
  const backendUrl = byId("backendUrl").value.trim();
  const sourceLanguage = byId("sourceLanguage").value;
  const targetLanguage = byId("targetLanguage").value;
  const runs = Math.max(1, Math.min(50, Number(byId("runs").value) || 1));
  const inputCode = byId("inputCode").value;
  const expectedCode = byId("expectedCode").value;
  const detailsEl = byId("details");
  const summaryEl = byId("summary");

  detailsEl.textContent = "Running benchmark...";
  summaryEl.textContent = "Please wait...";

  const results = [];
  for (let i = 0; i < runs; i += 1) {
    const result = await convertOnce({ backendUrl, code: inputCode, sourceLanguage, targetLanguage });
    results.push(result);
  }

  const times = results.map((r) => r.elapsedMs);
  const successCount = results.filter((r) => r.ok).length;
  const failureCount = runs - successCount;
  const providerCounts = {};
  for (const r of results) {
    providerCounts[r.provider] = (providerCounts[r.provider] || 0) + 1;
  }

  const lastSuccessful = [...results].reverse().find((r) => r.ok);
  const similarity = expectedCode.trim() && lastSuccessful
    ? jaccardSimilarity(expectedCode, lastSuccessful.convertedCode)
    : null;

  const avg = times.length ? Number((times.reduce((a, b) => a + b, 0) / times.length).toFixed(2)) : 0;
  const p50 = Number(percentile(times, 50).toFixed(2));
  const p95 = Number(percentile(times, 95).toFixed(2));
  const p99 = Number(percentile(times, 99).toFixed(2));

  summaryEl.textContent = [
    `Runs: ${runs}`,
    `Success: ${successCount}`,
    `Failures: ${failureCount}`,
    `Avg: ${avg} ms`,
    `P50: ${p50} ms`,
    `P95: ${p95} ms`,
    `P99: ${p99} ms`,
    similarity === null ? "Accuracy Score: N/A" : `Accuracy Score (Jaccard): ${similarity}%`
  ].join(" | ");

  detailsEl.textContent = JSON.stringify({
    summary: {
      runs,
      successCount,
      failureCount,
      avgMs: avg,
      p50Ms: p50,
      p95Ms: p95,
      p99Ms: p99,
      providerCounts,
      accuracyScoreJaccard: similarity
    },
    results
  }, null, 2);
}

async function fetchBackendPerf() {
  const backendUrl = byId("backendUrl").value.trim();
  const el = byId("backendPerf");
  el.textContent = "Fetching /health/perf...";
  try {
    const data = await fetch(`${backendUrl}/health/perf`).then((r) => r.json());
    el.textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    el.textContent = `Failed to fetch perf snapshot: ${err.message}`;
  }
}

async function resetBackendPerf() {
  const backendUrl = byId("backendUrl").value.trim();
  const el = byId("backendPerf");
  try {
    const data = await fetch(`${backendUrl}/health/perf/reset`, { method: "POST" }).then((r) => r.json());
    el.textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    el.textContent = `Failed to reset perf metrics: ${err.message}`;
  }
}

byId("runBtn").addEventListener("click", runBenchmark);
byId("fetchPerfBtn").addEventListener("click", fetchBackendPerf);
byId("resetPerfBtn").addEventListener("click", resetBackendPerf);

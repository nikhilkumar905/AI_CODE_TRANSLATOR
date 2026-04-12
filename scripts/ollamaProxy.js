#!/usr/bin/env node

/**
 * Local bridge for Ollama when public tunnels don't expose local model inventory.
 * It forwards requests to Ollama while forcing local host headers.
 */

const http = require('http');

const proxyPort = Number(process.env.OLLAMA_PROXY_PORT || 11500);
const targetHost = process.env.OLLAMA_TARGET_HOST || '127.0.0.1';
const targetPort = Number(process.env.OLLAMA_TARGET_PORT || 11434);

function sanitizeHeaders(incoming) {
  const headers = { ...incoming };
  headers.host = `localhost:${targetPort}`;

  delete headers['x-forwarded-for'];
  delete headers['x-real-ip'];
  delete headers['x-forwarded-host'];
  delete headers['x-forwarded-proto'];

  return headers;
}

const server = http.createServer((req, res) => {
  const upstream = http.request(
    {
      hostname: targetHost,
      port: targetPort,
      path: req.url,
      method: req.method,
      headers: sanitizeHeaders(req.headers)
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    }
  );

  upstream.on('error', (err) => {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: err.message }));
  });

  req.pipe(upstream);
});

server.listen(proxyPort, '127.0.0.1', () => {
  console.log(`Ollama proxy listening on http://127.0.0.1:${proxyPort}`);
});

# AI Code Translator

AI-powered code translation workspace with:
- Backend API (`backend`) on port `6001`
- Main frontend UI (`frontend`) on port `6002`
- Performance checker UI (`perf-checker`) on port `6003`

## Quick Start

From project root:

```powershell
npm install
npm run install:all
npm run start:all
```

## Deployable Structure

- `backend/`: Render web service (Node API)
- `frontend/`: Vercel static app (Vite + React)
- `perf-checker/`: optional local benchmark app
- `render.yaml`: Render Blueprint config
- `vercel.json`: root-level Vercel build and SPA routing config
- `backend/.env.example` and `frontend/.env.example`: deployment env templates

## Service URLs

- Main frontend: `http://localhost:6002`
- Perf checker: `http://localhost:6003`
- Backend health: `http://localhost:6001/health`
- Backend perf stats: `http://localhost:6001/health/perf`

## Backend Hardening Defaults

The backend includes:
- JSON request size limit (`JSON_LIMIT`, default `1mb`)
- Rate limiting on `/api/convert` (`RATE_LIMIT_WINDOW_MS`, default `60000`, and `RATE_LIMIT_MAX`, default `60`)
- Conversion timeout at route level (`CONVERT_TIMEOUT_MS`, default `45000`)
- Ollama request timeout (`OLLAMA_TIMEOUT_MS`, default `30000`)
- Ollama model keep-alive (`OLLAMA_KEEP_ALIVE`, default `15m`)
- Ollama model refresh cache (`OLLAMA_MODEL_REFRESH_MS`, default `300000`)
- Trained model subprocess timeout (`TRAINED_MODEL_TIMEOUT_MS`, default `60000`)
- Request correlation ID response header (`x-request-id`) and structured request logs

## Optional Environment Variables

Create `backend/.env` and set what you need:

```env
PORT=6001
JSON_LIMIT=1mb
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=60
CONVERT_TIMEOUT_MS=45000
OLLAMA_TIMEOUT_MS=30000
OLLAMA_KEEP_ALIVE=15m
OLLAMA_MODEL_REFRESH_MS=300000
TRAINED_MODEL_TIMEOUT_MS=60000
OLLAMA_BASE_URL=http://127.0.0.1:11434
```

## Useful Commands

```powershell
# Start only backend
npm --prefix backend run start

# Start only main frontend
npm --prefix frontend run dev -- --port 6002

# Start only perf checker
npm --prefix perf-checker run dev
```

### Localhost Mode (Default)

This project now runs in localhost-only mode for Ollama during local development:

- `OLLAMA_BASE_URL=http://127.0.0.1:11434`
- `OLLAMA_MODEL=codellama:latest`

Start Ollama in a separate terminal before starting backend:

```powershell
ollama serve
```

## Verification Checklist

```powershell
Invoke-WebRequest http://localhost:6001/health | Select-Object -ExpandProperty Content
Invoke-WebRequest http://localhost:6001/health/perf | Select-Object -ExpandProperty Content
```

If `start:all` fails because one port is already in use, stop the existing process on that port and rerun.

## Deploy Backend To Render

1. Push this repository to GitHub.
2. In Render, create a new Blueprint and point it to this repo.
3. Render will detect `render.yaml` and create the backend service.
4. In Render service environment variables, set:
	- `OLLAMA_BASE_URL` to your deployed Ollama endpoint (not localhost).
	- `OLLAMA_MODEL` to your deployed model name (for example `codellama:latest`).
	- `CORS_ORIGINS` to your Vercel frontend URL.
	- Optional Python/model paths (`PYTHON_EXECUTABLE`, `TRAINED_MODEL_PATH`) if you want Python<->C++ local model path explicitly configured.
5. Deploy and verify:
	- `https://<your-render-service>.onrender.com/health`

## Deploy Frontend To Vercel

1. Import the same repository into Vercel.
2. Keep Root Directory as repository root.
3. Vercel uses `vercel.json` to build `frontend` and publish `frontend/dist`.
4. Add environment variable:
	- `VITE_API_BASE_URL=https://<your-render-service>.onrender.com`
5. Deploy and open the Vercel URL.

## Post-Deploy Check

1. Open the Vercel app.
2. Run a conversion request.
3. Check Render logs for `http_request` entries and status `200`.
4. Verify CORS is correct if browser shows network blocking.

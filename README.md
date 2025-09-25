# Helport Toby Clone

Single Node.js service that serves the React UI (built with Vite) and the Express + WebSocket backend so the whole app deploys as one container or process.

## Prerequisites
- Node.js 18+
- npm 10+

## Environment configuration
- `.env` holds shared secrets for the backend (for example `DIFY_API_KEY`) and defaults the frontend to same-origin APIs via `VITE_WS_URL=/api/voicechat`.
- `.env.development` can override `VITE_*` variables, but with the combined server you usually do not need separate origins during local work.
- Provide production secrets (like `DIFY_API_KEY`, `PORT`, etc.) as real environment variables when you deploy.

## Local development
1. `npm install`
2. `npm run dev`
   - Starts a single Express process (default port `3001`) and mounts Vite in middleware mode, so both the UI and API share the same origin with HMR.
   - Override `PORT` if you need a different local port.

## Production build & run
1. `npm run build`
2. `npm start`
   - Express serves the compiled assets from `dist/` and handles `/api/*` plus the `/api/voicechat` WebSocket route.
   - Use `npm run preview` to build and immediately boot the production server in one command.

## Docker image
```
docker build -t helport-toby .
docker run -p 3000:3000 \
  -e PORT=3000 \
  -e DIFY_API_KEY=your-api-key \
  helport-toby
```
The image uses a multi-stage build: the first stage compiles the Vite frontend, the second installs only production dependencies and runs `node src/server.js`.

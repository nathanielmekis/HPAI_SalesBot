// server.js - tiny mock WS backend for /api/voicechat
import http from "http";
import express from "express";
import { WebSocketServer } from "ws";
import 'dotenv/config';
import path from "path";
import { fileURLToPath } from "url";

// __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
// parse JSON bodies for API routes
app.use(express.json());
// Minimal CORS for local development (not needed in prod same-origin)
app.use((req, res, next) => {
  if (process.env.NODE_ENV !== "production") {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

app.get("/health", (_, res) => res.send("ok"));
// 🔄 Replace your existing /api/chat handler with this one
function normalizeBase(u) {
  return (u || "https://agent.helport.ai")
    .replace(/\/+$/,'')   // trim trailing slash
    .replace(/\/v1$/,''); // remove accidental /v1
}


// NEW /api/chat with smart fallback: chat-messages -> workflows/run
app.post("/api/chat", async (req, res) => {
  const apiKey = process.env.DIFY_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "DIFY_API_KEY not set" });

  const baseUrl = (process.env.DIFY_BASE_URL || "https://agent.helport.ai").replace(/\/+$/,''); // no trailing slash

  // body from client
  const { query, inputs = {}, conversation_id, user, response_mode } = req.body || {};
  if (!query || typeof query !== "string") {
    return res.status(400).json({ error: "Missing required 'query' string" });
  }

  // common settings
  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiKey}`,
  };
  const userId = user || process.env.DIFY_DEFAULT_USER || "web";
  const respMode = response_mode || "blocking";

  // Attempt 1: chat-messages (for “App / Chat”)
  const bodyChat = {
    query,
    inputs,
    conversation_id,
    user: userId,
    response_mode: respMode,
  };

  try {
    let upstream = await fetch(`${baseUrl}/v1/chat-messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(bodyChat),
    });

    // If upstream doesn’t support this route, fall back to workflows/run
    if (upstream.status === 404 || upstream.status === 405) {
      // Attempt 2: workflows/run (for “Workflow / Chatflow”)
      // Many Dify setups expect the user prompt in inputs under a reserved key.
      // We'll send it as `query`, *and* also mirror as `input` to be safe.
      const bodyFlow = {
        inputs: { query, input: query, ...inputs },
        user: userId,
        response_mode: respMode,
        // some installs accept conversation_id for memory-enabled workflows
        conversation_id,
      };

      upstream = await fetch(`${baseUrl}/v1/workflows/run`, {
        method: "POST",
        headers,
        body: JSON.stringify(bodyFlow),
      });
    }

    const text = await upstream.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { error: "Upstream returned non-JSON", status: upstream.status, body: text }; }
    return res.status(upstream.status).json(json);

  } catch (err) {
    return res.status(500).json({ error: `Proxy error: ${String(err)}` });
  }
});




const distDir = path.join(__dirname, "..", "dist");
app.use(express.static(distDir, {
  setHeaders(res, filePath) {
    if (/\.(js|css|png|jpg|jpeg|gif|svg|webp|ico)$/.test(filePath)) {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    } else {
      res.setHeader("Cache-Control", "no-cache");
    }
  },
}));

// ✅ Express 5–compatible SPA fallback that skips /api
app.get(/^\/(?!api).*/, (req, res) => {
  res.sendFile(path.join(distDir, "index.html"));
});

server.on("upgrade", (req, socket, head) => {
  if (req.url?.startsWith("/api/voicechat")) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

wss.on("connection", (ws) => {
  const sessionId = Math.random().toString(36).slice(2);
  ws.send(JSON.stringify({ type: "session", session_id: sessionId }));

  let collecting = false;
  let audioBytes = 0;
  let partialTimer = null;
  const parts = ["What ", "programs ", "can you ", "offer me ", "today?"];
  let i = 0;

  function stopStreaming() {
    if (partialTimer) {
      clearInterval(partialTimer);
      partialTimer = null;
    }
  }

  ws.on("close", () => stopStreaming());

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      if (collecting) audioBytes += data.length;
      return;
    }

    try {
      const msg = JSON.parse(data.toString());

      // Typing mode: accept text messages from client
      if (msg.type === "text") {
        // Echo a partial_answer then final answer to simulate processing
        ws.send(JSON.stringify({ type: "partial_answer", text: msg.text.slice(0, 20) + (msg.text.length > 20 ? '…' : '') }));
        setTimeout(() => {
          ws.send(JSON.stringify({ type: "final_answer", text: `Reply to: ${msg.text}` }));
          ws.send(JSON.stringify({ type: "tts_url", url: "https://actions.google.com/sounds/v1/alarms/beep_short.ogg" }));
          ws.send(JSON.stringify({ type: "done" }));
        }, 250);
        return;
      }

      if (msg.type === "start") {
        collecting = true;
        audioBytes = 0;
        i = 0;
        stopStreaming();

        // STREAM partial transcripts while recording
        partialTimer = setInterval(() => {
          if (!collecting) return;
          if (i < parts.length) {
            ws.send(JSON.stringify({
              type: "partial_transcript",
              text: parts.slice(0, i + 1).join("")
            }));
            i++;
          } else {
            // Loop a bit or hold last partial; we’ll finalize on stop
            ws.send(JSON.stringify({
              type: "partial_transcript",
              text: parts.join("")
            }));
          }
        }, 150);
      }

      else if (msg.type === "stop") {
        collecting = false;
        stopStreaming();

        // Final user text
        const finalText = parts.join("");
        ws.send(JSON.stringify({ type: "final_transcript", text: finalText }));

        // Assistant streams, then finalizes
        ws.send(JSON.stringify({ type: "partial_answer", text: "We can walk you through a few options…" }));
        setTimeout(() => {
          ws.send(JSON.stringify({
            type: "final_answer",
            text: "Here are a few common programs...\n• Conventional\n• FHA\n• VA\n• Cash-out refi"
          }));
          ws.send(JSON.stringify({
            type: "tts_url",
            url: "https://actions.google.com/sounds/v1/cartoon/wood_plank_flicks.ogg"
          }));
          ws.send(JSON.stringify({ type: "done" }));
        }, 400);
      }
    } catch {}
  });
});


const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
server.listen(PORT, () => console.log(`Mock WS server on http://localhost:${PORT}`));

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} already in use. If another instance is running, stop it or set PORT to a different value.`);
    process.exit(1);
  }
  console.error('Server error:', err);
  process.exit(1);
});
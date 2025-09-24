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
// replace your existing /api/chat handler with this:

function normalizeBase(u) {
  return (u || "https://agent.helport.ai")
    .replace(/\/+$/,'')
    .replace(/\/v1$/,'');
}

app.post("/api/chat", async (req, res) => {
  const apiKey = process.env.DIFY_API_KEY;
  const base   = normalizeBase(process.env.DIFY_BASE_URL);
  const kind   = (process.env.DIFY_APP_TYPE || "workflow").toLowerCase(); // ← set to "workflow"

  if (!apiKey) return res.status(500).json({ error: "DIFY_API_KEY not set" });

  try {
    const { query, inputs = {}, conversation_id, user, response_mode } = req.body || {};
    const mode = response_mode || "blocking";
    const theUser = user || process.env.DIFY_DEFAULT_USER || "web";

    let upstreamUrl, upstreamBody;

    if (kind === "chat") {
      if (!query || typeof query !== "string") {
        return res.status(400).json({ error: "Missing required 'query' string for chat app" });
      }
      upstreamUrl  = `${base}/v1/chat-messages`;
      upstreamBody = { query, inputs, conversation_id, user: theUser, response_mode: mode };
    } else if (kind === "completion") {
      // completion apps don't use 'query'; pass everything via inputs
      upstreamUrl  = `${base}/v1/completion-messages`;
      upstreamBody = { inputs, user: theUser, response_mode: mode };
    } else { // workflow / chatflow
      // put the user's question inside inputs for the workflow
      if (!query || typeof query !== "string") {
        return res.status(400).json({ error: "Missing required 'query' string for workflow run" });
      }
      upstreamUrl  = `${base}/v1/workflows/run`;
      upstreamBody = {
        inputs: { query, ...inputs },
        user: theUser,
        response_mode: mode
      };
    }

    const r = await fetch(upstreamUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(upstreamBody),
    });

    const raw = await r.text();
    console.log(`[Dify ${r.status}] ${upstreamUrl}`);

    try {
      const json = JSON.parse(raw);
      return res.status(r.status).json(json);
    } catch {
      return res.status(r.status).type("text/plain").send(raw);
    }
  } catch (err) {
    console.error("Proxy /api/chat error:", err);
    return res.status(500).json({ error: String(err) });
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
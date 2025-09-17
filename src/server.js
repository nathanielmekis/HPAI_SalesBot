// server.js - tiny mock WS backend for /api/voicechat
import http from "http";
import express from "express";
import { WebSocketServer } from "ws";
import 'dotenv/config';

const app = express();
// parse JSON bodies for API routes
app.use(express.json());
// Minimal CORS for local development (allow Vite dev server to call this API)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

app.get("/health", (_, res) => res.send("ok"));

// Proxy endpoint to call a Dify workflow. Expects JSON body forwarded to workflow input.
app.post("/api/workflow", async (req, res) => {
  const apiKey = process.env.DIFY_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "DIFY_API_KEY not set" });

  try {
    // Ensure the payload matches the shape the Dify API expects.
    // The client already sends the top-level { inputs: {...}, response_mode, user }
    const payload = { ...req.body };
    // If user is missing, allow a default via DIFY_DEFAULT_USER for dev convenience
    if (!payload.user && process.env.DIFY_DEFAULT_USER) payload.user = process.env.DIFY_DEFAULT_USER;
    console.log("Proxying workflow payload:", JSON.stringify(payload));

    const resp = await fetch(`https://agent.helport.ai/v1/workflows/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload)
    });
    const json = await resp.json();
    return res.status(resp.status).json(json);
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/api/voicechat") {
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

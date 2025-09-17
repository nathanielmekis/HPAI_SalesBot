import React, { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Mic, Square, Volume2, Loader2 } from "lucide-react";

// Toby Clone Bot – Helport AI
// Apple‑inspired voice chat UI with proper logo reference

const ACCENT = "#00C389";
const BG_GRADIENT = `radial-gradient(1200px 600px at 50% -200px, rgba(0,195,137,0.14), transparent),
                     radial-gradient(800px 400px at 90% -100px, rgba(99,102,241,0.10), transparent)`;

export default function App() {
  const [connected, setConnected] = useState(false);
  const [recording, setRecording] = useState(false);
  const [sessionId, setSessionId] = useState("");
  const [messages, setMessages] = useState([]);
  const [status, setStatus] = useState("Ready");
  const wsRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioRef = useRef(null);
  const scrollerRef = useRef(null);

  useEffect(() => {
    if (scrollerRef.current) {
      scrollerRef.current.scrollTo({ top: scrollerRef.current.scrollHeight, behavior: "smooth" });
    }
  }, [messages]);

  const ensureSocket = async () => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      const ws = new WebSocket("/api/voicechat");
      wsRef.current = ws;
      ws.onopen = () => { setConnected(true); resolve(); };
      ws.onclose = () => setConnected(false);
      ws.onerror = (e) => reject(e);
      ws.onmessage = (ev) => {
        if (typeof ev.data !== "string") return;
        try {
          const msg = JSON.parse(ev.data);
          switch (msg.type) {
            case "session":
              setSessionId(msg.session_id || "");
              break;
            case "partial_transcript":
              setStatus("Listening…");
              break;
            case "final_transcript":
              setMessages((m) => [...m, { role: "user", text: msg.text }]);
              break;
            case "partial_answer":
              setStatus("Answering…");
              setMessages((m) => {
                const last = m[m.length - 1];
                if (!last || last.role === "user") return [...m, { role: "assistant", text: msg.text || "…" }];
                const copy = m.slice();
                copy[copy.length - 1] = { role: "assistant", text: msg.text || "…" };
                return copy;
              });
              break;
            case "final_answer":
              setMessages((m) => {
                const copy = m.slice();
                for (let i = copy.length - 1; i >= 0; i--) {
                  if (copy[i].role === "assistant") { copy[i] = { role: "assistant", text: msg.text }; break; }
                }
                return copy;
              });
              setStatus("Ready");
              break;
            case "tts_url":
              if (audioRef.current) {
                audioRef.current.src = msg.url;
                audioRef.current.play().catch(() => {});
              }
              break;
            case "done":
              setStatus("Ready");
              break;
            default:
              break;
          }
        } catch {}
      };
    });
  };

  const startConversation = async () => {
    await ensureSocket();
    const ws = wsRef.current;
    ws.send(JSON.stringify({ type: "start", voice_id: "top-sales-voice-001", temperature: 0.2, session_id: sessionId || undefined }));
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mr = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
    mediaRecorderRef.current = mr;
    setRecording(true);
    setStatus("Listening…");
    mr.ondataavailable = async (e) => {
      if (e.data.size && ws.readyState === WebSocket.OPEN) ws.send(await e.data.arrayBuffer());
    };
    mr.onstop = () => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "stop" }));
      setStatus("Thinking…");
    };
    mr.start(220);
  };

  const endConversation = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
      setRecording(false);
    }
  };

  const styles = {
    page: {
      minHeight: "100vh",
      backgroundImage: BG_GRADIENT,
      backgroundColor: "#ffffff",
      color: "#0a0a0a",
      display: "flex",
      flexDirection: "column",
    },
    topbar: {
      maxWidth: 1100,
      width: "100%",
      margin: "0 auto",
      padding: "24px 20px",
      display: "flex",
      alignItems: "center",
      gap: 12,
    },
    brand: { height: 36 },
    spacer: { marginLeft: "auto", fontSize: 12, opacity: 0.6 },
    hero: { maxWidth: 820, width: "100%", margin: "0 auto 16px", padding: "0 20px", textAlign: "center" },
    h1: { fontSize: 36, fontWeight: 600, letterSpacing: -0.4, margin: 0 },
    p: { marginTop: 8, opacity: 0.7 },
    cardWrap: { maxWidth: 820, width: "100%", margin: "0 auto", padding: "0 20px" },
    card: {
      borderRadius: 24,
      border: "1px solid rgba(0,0,0,0.08)",
      background: "rgba(255,255,255,0.85)",
      backdropFilter: "blur(8px)",
      boxShadow: "0 6px 24px rgba(0,0,0,0.06)",
      overflow: "hidden",
    },
    scroll: { height: "56vh", overflowY: "auto", padding: 20 },
    emptyText: { opacity: 0.6, fontSize: 14 },
    row: (justify) => ({ display: "flex", justifyContent: justify, marginBottom: 10 }),
    bubble: (me) => ({
      background: me ? ACCENT : "rgba(255,255,255,0.95)",
      color: me ? "white" : "#0a0a0a",
      borderRadius: 18,
      padding: "10px 14px",
      maxWidth: "85%",
      boxShadow: "0 1px 6px rgba(0,0,0,0.06)",
    }),
    controls: { display: "flex", alignItems: "center", gap: 12, padding: 16, borderTop: "1px solid rgba(0,0,0,0.08)" },
    cta: (danger) => ({
      display: "inline-flex",
      alignItems: "center",
      gap: 8,
      border: "none",
      borderRadius: 30,
      padding: "12px 18px",
      fontSize: 14,
      fontWeight: 600,
      color: "#fff",
      background: danger ? "#ff453a" : ACCENT,
      cursor: "pointer",
      boxShadow: "0 4px 12px rgba(0,0,0,0.12)",
    }),
    status: { fontSize: 12, opacity: 0.7, display: "inline-flex", alignItems: "center", gap: 6 },
    footer: { maxWidth: 1100, width: "100%", margin: "0 auto", padding: "32px 20px", textAlign: "center", fontSize: 12, opacity: 0.6 },
  };

  return (
    <div style={styles.page}>
      {/* Top Bar */}
      <div style={styles.topbar}>
        {/* Use public URL or /logo.png placed in public folder for production */}
        <img src="/logo.png" alt="Helport AI" style={styles.brand} />
        <div style={styles.spacer}>Session: {sessionId || "new"} · {connected ? "Online" : "Offline"}</div>
      </div>

      {/* Hero */}
      <section style={styles.hero}>
        <motion.h1 initial={{opacity:0,y:6}} animate={{opacity:1,y:0}} style={styles.h1}>Toby Clone Bot</motion.h1>
        <motion.p initial={{opacity:0,y:6}} animate={{opacity:1,y:0}} style={styles.p}>
          Voice demo of our sales knowledge base — ask anything and hear the answer in our top seller’s voice.
        </motion.p>
      </section>

      {/* Card */}
      <main style={styles.cardWrap}>
        <div style={styles.card}>
          {/* Chat Scroll */}
          <div ref={scrollerRef} style={styles.scroll}>
            {messages.length === 0 ? (
              <div style={{ height: "100%", display: "grid", placeItems: "center" }}>
                <div style={styles.emptyText}>
                  Tap <span style={{fontWeight:600, color: ACCENT}}>Start conversation</span> and speak — we’ll transcribe, retrieve, and reply.
                </div>
              </div>
            ) : (
              <div>
                {messages.map((m, i) => (
                  <motion.div key={i} initial={{opacity:0,y:4}} animate={{opacity:1,y:0}} style={styles.row(m.role === "user" ? "flex-end" : "flex-start")}>
                    <div style={styles.bubble(m.role === "user")}>{m.text}</div>
                  </motion.div>
                ))}
              </div>
            )}
          </div>

          {/* Controls */}
          <div style={styles.controls}>
            <button
              onClick={recording ? endConversation : startConversation}
              style={styles.cta(recording)}
              aria-label={recording ? "End conversation" : "Start conversation"}
            >
              {recording ? <Square size={16}/> : <Mic size={16}/>} {recording ? "End conversation" : "Start conversation"}
            </button>

            <span style={styles.status}>
              {status.includes("Listening") ? <Mic size={14}/> : status.includes("Thinking") ? <Loader2 size={14} className="animate-spin"/> : <Volume2 size={14}/>}
              {status}
            </span>
          </div>
        </div>
      </main>

      <audio ref={audioRef} preload="auto" />

      {/* Footer */}
      <footer style={styles.footer}>
        © {new Date().getFullYear()} Helport AI · Built for live demos · Voice: top-sales-voice-001
      </footer>
    </div>
  );
}

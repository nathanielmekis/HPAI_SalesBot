import React, { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Mic, Square, Volume2, Loader2, ArrowUp } from "lucide-react";

// Toby Clone Bot – Helport AI
// Apple-inspired voice chat UI with proper logo reference
// Use Vite env to override in dev if you don't set a proxy:
const WS_URL = import.meta.env.VITE_WS_URL || "/api/voicechat";
const ACCENT = "#00C389";
const BG_GRADIENT = `radial-gradient(1200px 600px at 50% -200px, rgba(0,195,137,0.14), transparent),
                     radial-gradient(800px 400px at 90% -100px, rgba(99,102,241,0.10), transparent)`;

const ABBR = [
  "U.S.", "U.K.", "e.g.", "i.e.", "etc.", "vs.",
  "Mr.", "Mrs.", "Ms.", "Dr.", "Prof.",
  "Inc.", "Ltd.", "Jr.", "Sr.", "St.", "No.",
  "Jan.", "Feb.", "Mar.", "Apr.", "Jun.", "Jul.", "Aug.", "Sep.", "Sept.", "Oct.", "Nov.", "Dec.",
];

function protectAbbrDots(s) {
  let out = s;
  for (const a of ABBR) {
    const safe = a.replace(/\./g, "§"); // 用 § 暂代句点
    // 精确替换大小写匹配（简单起见用原样大小写）
    out = out.replaceAll(a, safe);
  }
  return out;
}
function restoreAbbrDots(s) { return s.replace(/§/g, "."); }

// 智能分句：在 . ! ? 后、且后面像是句首（引号/括号/大写/数字）再断
function splitIntoSentencesSmart(text) {
  if (!text) return [];
  const protectedText = protectAbbrDots(text);
  const parts = protectedText
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+(?=["'(\[]?[A-Z0-9])/); // 简洁有效的启发式
  return parts.map(restoreAbbrDots).map(s => s.trim()).filter(Boolean);
}

// 把句子按“2–3句 / <= 400 字”打包
function groupSentencesToChunks(sentences, { maxChars = 400, minSent = 2, maxSent = 3 } = {}) {
  const chunks = [];
  let cur = [];
  let curLen = 0;
  for (const s of sentences) {
    const willLen = curLen + (curLen ? 1 : 0) + s.length;
    if (cur.length >= maxSent || (cur.length >= minSent && willLen > maxChars)) {
      chunks.push(cur.join(" "));
      cur = [s];
      curLen = s.length;
    } else {
      cur.push(s);
      curLen = willLen;
    }
  }
  if (cur.length) chunks.push(cur.join(" "));
  return chunks;
}



// Pick a supported audio mime type (Safari prefers mp4/mpeg)
function pickAudioMime() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",    // Safari
    "audio/mpeg",   // Safari fallback
  ];
  for (const t of candidates) {
    try {
      if (window.MediaRecorder?.isTypeSupported?.(t)) return t;
    } catch {}
  }
  return ""; // let browser decide
}

export default function App() {
  const [mode, setMode] = useState("voice"); // 'voice' or 'type'
  const [textInput, setTextInput] = useState("");
  const [connected, setConnected] = useState(false);
  const [recording, setRecording] = useState(false);
  const [sessionId, setSessionId] = useState("");
  const [messages, setMessages] = useState([]);
  const [inputFocused, setInputFocused] = useState(false);
  const [conversationId, setConversationId] = useState(() => {
    try { return localStorage.getItem("dify_conversation_id") || ""; } catch { return ""; }
  });
  const [status, setStatus] = useState("Ready");

  const wsRef = useRef(null);
  const mediaRecorderRef = useRef(/** @type {MediaRecorder|null} */(null));
  const streamRef = useRef(/** @type {MediaStream|null} */(null));
  const audioRef = useRef(null);
  const scrollerRef = useRef(null);
  const API_BASE = import.meta.env.VITE_API_BASE || "";
  const AVATAR_URL = "/toby.png"; // lives in /public
  const START_FRESH_ON_LOAD = true;

  const chunksRef = useRef([]);
  const ASR_USER = "XBOT_DEV"; 

  const ttsCacheRef = useRef(new Map());

  // 正在播放哪条消息（用文本当 key；如果你有 messageId 更好）
  const [playingKey, setPlayingKey] = useState(null);
  // 浏览器 audio 当前是否在播（不依赖队列长度）
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);

  // 自动播放门禁（被拦截时给出“点一下启用音频”的按钮）
  const [needsUserTap, setNeedsUserTap] = useState(false);

  // 为“每条气泡缓存各自的音频分段与合并结果”
  // Map<msgId, { items: Array<{ab:ArrayBuffer, mime:string}>, mergedUrl?: string }>
  const messageAudioStoreRef = useRef(new Map());
  const makeMsgId = () =>
    (window.crypto?.randomUUID?.() ?? `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`);

  // 用一个监听替换你之前的 ended 监听（队列续播 + 状态维护）
  useEffect(() => {
    const a = audioRef.current; if (!a) return;

    const onPlay = () => setIsAudioPlaying(true);
    const onPause = () => setIsAudioPlaying(false);
    const onEnded = async () => {
      // 播完当前段，看看队列
      ttsQueueRef?.current?.shift?.();
      if (ttsQueueRef?.current?.length) {
        a.src = ttsQueueRef.current[0];
        await tryPlayElement(a);
      } else {
        setIsAudioPlaying(false);
        setPlayingKey(null);
        setStatus(s => (s.includes("Thinking") ? s : "Ready"));
      }
    };

    a.addEventListener("play", onPlay);
    a.addEventListener("pause", onPause);
    a.addEventListener("ended", onEnded);
    return () => {
      a.removeEventListener("play", onPlay);
      a.removeEventListener("pause", onPause);
      a.removeEventListener("ended", onEnded);
    };
  }, []);

  function stopSpeaking() {
    const a = audioRef.current; if (!a) return;
    try { a.pause(); a.currentTime = 0; } catch {}
    if (ttsQueueRef?.current) ttsQueueRef.current.length = 0; // 清空队列（分段模式）
    setPlayingKey(null);
    setIsAudioPlaying(false);
    setStatus(s => (s.includes("Thinking") ? s : "Ready"));
  }  

  async function tryPlayElement(a) {
    try {
      setNeedsUserTap(false);
      await a.play();
    } catch (e) {
      if (e?.name === "NotAllowedError") {
        // 被浏览器自动播放策略拒绝：提示用户点一下
        setNeedsUserTap(true);
      }
    }
  }

  async function speakText(text, lang = "en") {
    if (!text || !audioRef.current) return;
    try {
      // 呈现 Speaking… 状态（不覆盖 Thinking…）
      setStatus(s => (s.includes("Thinking") ? s : "Speaking…"));
  
      // 命中缓存直接播
      const safe = sanitizeForTTS(text);
      let url = ttsCacheRef.current.get(safe);
      if (!url) {
        const resp = await fetch(`${API_BASE || ""}/api/tts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: safe, text_language: lang }),
        });
        if (!resp.ok) throw new Error(`TTS ${resp.status}`);
        const buf = await resp.arrayBuffer();
        const blob = new Blob([buf], { type: resp.headers.get("content-type") || "audio/mpeg" });
        url = URL.createObjectURL(blob);
        ttsCacheRef.current.set(safe, url);
      }
      
      try { audioRef.current.pause(); } catch {}
      try { audioRef.current.currentTime = 0; } catch {}
      audioRef.current.src = url;
      // 播放失败静默（例如用户没交互导致 autoplay 限制）
      await audioRef.current.play().catch(() => {});
    } catch (e) {
      setMessages(m => [...m, { role: "assistant", text: `TTS error: ${e?.message || e}` }]);
    } finally {
      setStatus(s => (s.includes("Thinking") ? s : "Ready"));
    }
  }
  
  // 清理缓存（新对话时用）
  function clearTtsCache() {
    for (const u of ttsCacheRef.current.values()) URL.revokeObjectURL(u);
    ttsCacheRef.current.clear();
  }

  // 缓存：chunk 文本 -> { url, blob, ab(ArrayBuffer), mime }
  const ttsObjCacheRef = useRef(new Map());
  // 播放队列：只存 URL
  const ttsQueueRef = useRef([]);
  // 当前答案的分段原始音频（用于“一次性重播”合并）
  const currentAnswerAudioRef = useRef({ key: "", items: [], mergedUrl: null });

  function resetCurrentAnswerAudio(key) {
    // 释放旧的合并 URL
    const cur = currentAnswerAudioRef.current;
    if (cur.mergedUrl) { URL.revokeObjectURL(cur.mergedUrl); }
    currentAnswerAudioRef.current = { key, items: [], mergedUrl: null };
  }

  const ttsInflightRef = useRef(new Map());

  // 取/生成一个 chunk 的音频
  async function getTtsAudioObj(chunkText, lang="en") {
    const safe = sanitizeForTTS(chunkText);
    const cacheKey = `${lang}::${safe}`;
    if (ttsObjCacheRef.current.has(cacheKey)) return ttsObjCacheRef.current.get(cacheKey);

    // 如果已有同 key 的请求在飞，直接复用同一个 Promise
    if (ttsInflightRef.current.has(cacheKey)) return ttsInflightRef.current.get(cacheKey);

    const p = (async () => {
    const resp = await fetch(`${API_BASE || ""}/api/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "audio/mpeg" },
        body: JSON.stringify({ text: safe, text_language: lang }),
      });
      if (!resp.ok) throw new Error(`TTS ${resp.status}`);
      const ab = await resp.arrayBuffer();
      const mime = resp.headers.get("content-type") || "audio/mpeg";
      const blob = new Blob([ab], { type: mime });
      const url = URL.createObjectURL(blob);
      const obj = { url, blob, ab, mime };
      ttsObjCacheRef.current.set(cacheKey, obj);
      return obj;
    })();
    ttsInflightRef.current.set(cacheKey, p);
    try { return await p; }
    finally { ttsInflightRef.current.delete(cacheKey); }
  }

  // 入队并在空闲时启动播放
  async function enqueueAndPlay(audioUrl) {
    ttsQueueRef.current.push(audioUrl);
    const a = audioRef.current;
    if (!a) return;
    // 如果当前不在播，立刻播队首
    if (a.paused && ttsQueueRef.current.length === 1) {
      a.src = ttsQueueRef.current[0];
      await tryPlayElement(a);
    }
  }


  // 主接口：长文本智能分段 → 到段即播；replay=true 时合并为单 WAV 一次性播放
  async function speakTextSmart(fullText, lang = "en", { replay = false, msgId } = {}) {
    const sentences = splitIntoSentencesSmart(fullText);
    const chunks = groupSentencesToChunks(sentences, { maxChars: 400, minSent: 2, maxSent: 3 });

    if (!replay) {
      setStatus(s => (s.includes("Thinking") ? s : "Speaking…"));
      // 为该消息准备缓存容器
      if (msgId && !messageAudioStoreRef.current.has(msgId)) {
        messageAudioStoreRef.current.set(msgId, { items: [], mergedUrl: null });
      }
      // 顺序生成并入队；第一段到就先播
      for (let i = 0; i < chunks.length; i++) {
        const obj = await getTtsAudioObj(chunks[i], lang);
        // 存到“当前答案”的原始分段（用于合并）
        if (msgId) {
          const entry = messageAudioStoreRef.current.get(msgId);
          entry.items.push({ ab: obj.ab, mime: obj.mime });
        }
        await enqueueAndPlay(obj.url);
      }
      setStatus(s => (s.includes("Thinking") ? s : "Ready"));
      return;
    }

    // —— 重播：按该消息 id 的分段合并为单个 WAV 再播 ——
    try {
      setStatus("Preparing…");
      const entry = msgId ? messageAudioStoreRef.current.get(msgId) : null;
      const items = entry?.items ?? [];
      if (!items.length) {
        // 没缓存（例如刷新后），退化为顺序重播并重新缓存
        return speakTextSmart(fullText, lang, { replay: false, msgId });
      }
      if (entry.mergedUrl) {
        // 已经合并过，直接播
        ttsQueueRef.current.length = 0;
        const a = audioRef.current;
        if (a) {
          a.pause(); a.currentTime = 0; a.src = entry.mergedUrl;
          await tryPlayElement(a);
        }
        setStatus("Ready");
        return;
      }
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      try { await ctx.resume?.(); } catch {}
      const decoded = [];
      for (const it of items) {
        const buf = await ctx.decodeAudioData(it.ab.slice(0)); // decode mp3/wav → AudioBuffer
        decoded.push(buf);
      }
      const sampleRate = decoded[0].sampleRate;
      const channels = decoded[0].numberOfChannels;
      // 简单假设 sampleRate/通道一致（大多数 TTS 一致）；否则可做重采样
      let totalLen = 0;
      for (const b of decoded) totalLen += b.length;

      // 拼接到一个大的 AudioBuffer
      const out = ctx.createBuffer(channels, totalLen, sampleRate);
      let offset = 0;
      for (const b of decoded) {
        for (let ch = 0; ch < channels; ch++) {
          out.getChannelData(ch).set(b.getChannelData(ch), offset);
        }
        offset += b.length;
      }

      // 导出为 WAV
      const mergedWavBlob = audioBufferToWavBlob(out);
      const mergedUrl = URL.createObjectURL(mergedWavBlob);
      // 记录，避免下次再做
      if (entry.mergedUrl) URL.revokeObjectURL(entry.mergedUrl);
      entry.mergedUrl = mergedUrl;

      // 清空队列并一次性播放
      ttsQueueRef.current.length = 0;
      const a = audioRef.current;
      if (a) {
        a.pause();
        a.currentTime = 0;
        a.src = mergedUrl;
        await tryPlayElement(a);
      }
    } catch (e) {
      setMessages(m => [...m, { role: "assistant", text: `Replay merge error: ${e?.message || e}` }]);
    } finally {
      setStatus("Ready");
    }
  }

  // 把 AudioBuffer 导成 WAV（float32 → 16-bit PCM）
  function audioBufferToWavBlob(buffer) {
    const numCh = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const numFrames = buffer.length;
    const bytesPerSample = 2; // 16-bit
    const blockAlign = numCh * bytesPerSample;
    const dataSize = numFrames * blockAlign;
    const headerSize = 44;
    const ab = new ArrayBuffer(headerSize + dataSize);
    const dv = new DataView(ab);
    let p = 0;

    // RIFF header
    writeStr("RIFF"); u32(headerSize + dataSize - 8);
    writeStr("WAVE");
    writeStr("fmt "); u32(16); u16(1); u16(numCh); u32(sampleRate); u32(sampleRate * blockAlign); u16(blockAlign); u16(16);
    writeStr("data"); u32(dataSize);

    // Interleave
    const chData = [];
    for (let ch = 0; ch < numCh; ch++) chData.push(buffer.getChannelData(ch));
    for (let i = 0; i < numFrames; i++) {
      for (let ch = 0; ch < numCh; ch++) {
        let s = Math.max(-1, Math.min(1, chData[ch][i]));
        s = s < 0 ? s * 0x8000 : s * 0x7FFF;
        dv.setInt16(p, s, true); p += 2;
      }
    }
    return new Blob([ab], { type: "audio/wav" });

    // helpers
    function writeStr(s){ for (let i=0;i<s.length;i++) dv.setUint8(p++, s.charCodeAt(i)); }
    function u16(v){ dv.setUint16(p, v, true); p+=2; }
    function u32(v){ dv.setUint32(p, v, true); p+=4; }
  }

  useEffect(() => {
    if (!START_FRESH_ON_LOAD) return;
    try {
      localStorage.removeItem("dify_conversation_id");
      localStorage.removeItem("dify_conversation_ts"); // if you ever added TTL
    } catch {}
    setConversationId("");   // force a new thread
    setMessages([]);         // clear UI
    setStatus("Ready");
  }, []); // runs once after first render

  useEffect(() => {
    if (scrollerRef.current) {
      scrollerRef.current.scrollTo({ top: scrollerRef.current.scrollHeight, behavior: "smooth" });
    }
  }, [messages]);

  // Clean up on unload (stop mic if active)
  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
      }
      streamRef.current?.getTracks()?.forEach(t => t.stop());
      wsRef.current?.close?.();
    };
  }, []);


  async function handleVoiceClip() {
    try {
      const parts = chunksRef.current;
      chunksRef.current = [];
      if (!parts.length) { setStatus("Ready"); return; }
  
      // 生成 Blob（浏览器实际可能是 webm/opus；后端能吃就行）
      const blob = new Blob(parts, { type: parts[0]?.type || "audio/webm" });
  
      setStatus("Uploading…");
      const fileId = await asrUpload(blob);     // ① 上传，拿 id
      setStatus("Transcribing…");
      const text = await asrRun(fileId);        // ② 调 ASR，拿文本
  
      // 把识别文本当作用户发言插入，然后复用你现有的 runChat
      if (text && text.trim()) {
        setMessages(m => [...m, { role: "user", text }]);
        setStatus("Thinking…");
        await runChat(text);
      } else {
        setMessages(m => [...m, { role: "assistant", text: "ASR returned empty text." }]);
        setStatus("Ready");
      }
    } catch (e) {
      setMessages(m => [...m, { role: "assistant", text: `ASR error: ${e?.message || e}` }]);
      setStatus("Ready");
    }
  }

  async function asrUpload(blob) {
    // POST /api/asr/upload  -> 透传到 https://agent.helport.ai/v1/files/upload
    const form = new FormData();
    form.append("user", "abc123"); // 你示例里的字段
    form.append("file", new File([blob], "recording.webm", { type: blob.type || "audio/webm" }));
  
    const resp = await fetch(`${API_BASE || ""}/api/asr/upload`, { method: "POST", body: form });
    if (!resp.ok) throw new Error(`Upload failed: ${resp.status}`);
    const json = await resp.json();
    const fileId = json?.id;
    if (!fileId) throw new Error("Upload OK but no file id.");
    return fileId;
  }
  
  async function asrRun(fileId) {
    // POST /api/asr/run -> 透传到 https://agent.helport.ai/v1/workflows/run
    const payload = {
      inputs: { speech: { transfer_method: "local_file", upload_file_id: fileId, type: "audio" } },
      response_mode: "blocking",
      user: ASR_USER,
    };
    const resp = await fetch(`${API_BASE || ""}/api/asr/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) throw new Error(`ASR failed: ${resp.status}`);
    const json = await resp.json();
    return json?.data?.outputs?.text || "";
  }
  
  function sanitizeForTTS(input) {
    if (!input) return "";
    let text = input;
  
    // 1) 列表项：" - " -> "• "（仅行首的短横）
    text = text.replace(/^\s*-\s+/gm, "• ");
  
    // 2) 数值区间: "3-5" 或 "0.7-0.8" -> "3 to 5"
    text = text.replace(
      /(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)(?=\s*[%a-zA-Z]|[^\d]|$)/g,
      "$1 to $2"
    );
  
    // 3) 词内连字符: "cash-out"、"follow-up" -> "cash out"、"follow up"
    // 仅替换 ASCII '-'，不动 U+2011/2010 等真正的连字符
    text = text.replace(/(\p{L})-(?=\p{L})/gu, "$1 ");
  
    // 4) 负数（普通场景）: "-5" -> "negative 5"
    text = text.replace(/(^|[^\d])-(\d+(?:\.\d+)?)(?![\d-])/g, "$1negative $2");
  
    // 4.1) 货币负数: "$-100" -> "negative $100"
    text = text.replace(/([$€£])-(\d+(?:[\d,\.])*)/g, "negative $1$2");
  
    // 4.2) 负百分比: "-5%" -> "negative 5 percent"
    text = text.replace(/-(\d+(?:\.\d+)?)\s*%/g, "negative $1 percent");
  
    // 5) en/em dash 读成停顿
    text = text.replace(/[–—]/g, ", ");
  
    // 6) 合并空格
    text = text.replace(/\s{2,}/g, " ").trim();
  
    return text;
  }  
  

  // ----- Start mic + (optionally) WS -----
  const startConversation = async () => {
    try {
      // Mic first (so UI toggles even if WS fails)
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mime = pickAudioMime();
      const opts = mime ? { mimeType: mime } : undefined;
      const mr = new MediaRecorder(stream, opts);
      mediaRecorderRef.current = mr;

      setRecording(true);
      setStatus("Listening…");
      chunksRef.current = [];

      mr.ondataavailable = async (e) => {
        if (e.data && e.data.size) chunksRef.current.push(e.data);
      };
      mr.onstop = () => { void handleVoiceClip(); };

      mr.start(220); // low-latency chunks
    } catch (err) {
      console.error(err);
      setStatus(`Mic error: ${err?.name || err?.message || err}`);
      setRecording(false);
      // Be sure to stop any tracks if partially opened
      streamRef.current?.getTracks()?.forEach(t => t.stop());
      setMode("type"); // switch to type mode on mic fail
    }
  };

  // ----- Send typed message -----
  const sendTextMessage = async () => {
    if (!textInput?.trim()) return;
    // Optimistically append user message
    setMessages(m => {
      // Append user message, then a provisional assistant 'thinking' bubble
      return [...m, { role: "user", text: textInput }, { role: "assistant", text: "Thinking…", provisional: true }];
    });
    setStatus("Thinking…");

    await runChat(textInput);

    setTextInput("");
  };

  // ----- Call Dify Chatflow via server proxy (blocking) -----
  const runChat = async (query) => {
    setStatus("Chatflow…");
    try {
      const body = {
        query: query,
        inputs: {
          // carry forward any app vars you used in workflow, e.g. datasets, toggles, etc.
          qa_dataset_id: "a034b9b4-9b64-40d2-b3c1-951281f84dc6",
        },
        conversation_id: conversationId || undefined,
        user: "Enoch@HELPORT.AI",
        response_mode: "blocking",
      };

      const resp = await fetch(`${API_BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await resp.json();

      // Dify Chatflow commonly returns: { answer, conversation_id, ... }
      const answer =
        (typeof json?.answer === "string" && json.answer) ||
        (typeof json?.data?.answer === "string" && json.data.answer) ||
        // fallback if a tool returns a structured output
        JSON.stringify(json, null, 2);

      if (json?.conversation_id && json.conversation_id !== conversationId) {
        setConversationId(json.conversation_id);
        try { localStorage.setItem("dify_conversation_id", json.conversation_id); } catch {}
      }

      const finalText = String(answer);
      let targetIndex = -1;
      setMessages((m) => {
        const copy = m.slice();
        for (let i = copy.length - 1; i >= 0; i--) {
          if (copy[i].role === "assistant" && copy[i].provisional) {
            const id = makeMsgId();
            copy[i] = { role: "assistant", text: finalText, id };
            // 立刻开始对该消息做分段 TTS（到段即播），并把分段缓存到该 id 下
            setPlayingKey(id);
            setTimeout(() => speakTextSmart(finalText, "en", { replay: false, msgId: id }), 0);
            targetIndex = i;
            break;
          }
        }
        if (targetIndex === -1) {
          const id = makeMsgId();
          copy.push({ role: "assistant", text: finalText, id });
          setPlayingKey(id);
          setTimeout(() => speakTextSmart(finalText, "en", { replay: false, msgId: id }), 0);
          targetIndex = copy.length - 1;
        }
        return copy;
      });
      setStatus("Ready");
    } catch (err) {
      setMessages((m) => {
        const copy = m.slice();
        for (let i = copy.length - 1; i >= 0; i--) {
          if (copy[i].role === "assistant" && copy[i].provisional) {
            copy[i] = { role: "assistant", text: `Chatflow error: ${err?.message || err}` };
            return copy;
          }
        }
        return [...m, { role: "assistant", text: `Chatflow error: ${err?.message || err}` }];
      });
      setStatus(`Chatflow error: ${err?.message || err}`);
    }
  };


  // ----- End mic -----
  const endConversation = () => {
    try {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
      }
    } catch {}
    // Stop all tracks to release mic light in the browser UI
    streamRef.current?.getTracks()?.forEach(t => t.stop());
    streamRef.current = null;
    setRecording(false);
  };

  // put inside your App component
  const newConversation = () => {
    // Stop mic cleanly if recording
    try {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
      }
    } catch {}
    streamRef.current?.getTracks()?.forEach(t => t.stop());
    streamRef.current = null;
    setRecording(false);

    // Optionally close the WS session (not required for Dify new chat, but tidy)
    try { wsRef.current?.close?.(); } catch {}

    // Clear persisted conversation id (and any timestamp you might add later)
    try {
      localStorage.removeItem("dify_conversation_id");
      localStorage.removeItem("dify_conversation_ts"); // if you adopt TTL later
    } catch {}

    // Reset UI state
    stopSpeaking();
    clearTtsCache();
    // 释放每条消息的合并 URL，避免内存泄露
    for (const entry of messageAudioStoreRef.current.values()) {
      if (entry?.mergedUrl) URL.revokeObjectURL(entry.mergedUrl);
    }
    messageAudioStoreRef.current.clear();
    setConversationId("");
    setMessages([]);
    setStatus("Ready");
  };

  // ===== Derived gating for CTA =====
  const hasProvisionalAssistant = messages.some(
    (m) => m.role === "assistant" && m.provisional
  );

  // “文字还没 Ready？”
  const isThinking =
    hasProvisionalAssistant ||
    /Thinking|Chatflow|Uploading|Transcribing/i.test(status);

  // “音频还在说？”
  const isSpeaking =
    isAudioPlaying ||
    needsUserTap ||
    /Speaking|Preparing/i.test(status);

  // 统一生成 Voice CTA 的渲染数据
  const voiceCta = (() => {
    if (recording) {
      return {
        label: "End conversation",
        onClick: endConversation,
        disabled: false,
        danger: true,
        icon: <Square size={16} />,
        aria: "End conversation",
      };
    }
    if (isThinking) {
      return {
        label: "Thinking",
        onClick: undefined,
        disabled: true,
        danger: false,
        icon: <Loader2 size={16} className="animate-spin" />,
        aria: "Thinking… please wait",
      };
    }
    if (isSpeaking) {
      return {
        label: "Speaking",
        onClick: undefined,
        disabled: true,
        danger: false,
        icon: <Volume2 size={16} />,
        aria: "Speaking… please wait",
      };
    }
    return {
      label: "Start conversation",
      onClick: startConversation,
      disabled: false,
      danger: false,
      icon: <Mic size={16} />,
      aria: "Start conversation",
    };
  })();

  // ====== NEW: minimal helpers to meet your two UI requirements ======
  // Derived status: hide "Ready/Listening" when in Type mode; only show when thinking
  const displayStatus =
    mode === "type" ? (status.includes("Thinking") ? status : "") : status;

  const statusIcon = () => {
    if (!displayStatus) return null;
    if (displayStatus.includes("Listening")) return <Mic size={14} />;
    if (displayStatus.includes("Thinking") || displayStatus.includes("Chatflow"))
      return <Loader2 size={14} className="animate-spin" />;
    return <Volume2 size={14} />;
  };

  // Mode switches: when entering Type, stop mic and clear idle status
  const switchToVoice = () => setMode("voice");
  const switchToType = () => {
    if (recording) endConversation();
    setMode("type");
    if (!status.includes("Thinking")) setStatus("");
  };

  // Mode-aware empty-state copy
  const EmptyHint = () => (
    <div style={styles.emptyText}>
      {mode === "voice" ? (
        <>
          Click <span style={{ fontWeight: 600, color: ACCENT }}>Start conversation</span> and speak — we’ll transcribe, retrieve, and reply.
        </>
      ) : (
        <>
          <div>
            Type a question below and press <span style={{ fontWeight: 600, color: ACCENT }}>Enter</span> — we’ll retrieve and reply.
          </div>
        </>
      )}
    </div>
  );
  // ================================================================

  // ----- Styles -----
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
    toggleDivider: { width: 1, height: 18, background: "rgba(0,0,0,0.08)", margin: "0 2px" },
    brand: { height: 36 },
    spacer: { marginLeft: "auto", fontSize: 12, opacity: 0.6 },
    hero: { maxWidth: 820, width: "100%", margin: "0 auto 16px", padding: "0 20px", textAlign: "center" },
    h1: { fontSize: 36, fontWeight: 600, letterSpacing: -0.4, margin: 0 },
    p: { marginTop: 8, opacity: 0.7 },
    cardWrap: { maxWidth: 820, width: "100%", margin: "0 auto", padding: "0 20px" },
    card: {
      borderRadius: 24,
      border: "2px solid rgba(0,0,0,0.08)",
      background: "rgba(255,255,255,0.85)",
      backdropFilter: "blur(8px)",
      boxShadow: "0 6px 24px rgba(0,0,0,0.06)",
      overflow: "hidden",
    },
    scroll: { height: "56vh", overflowY: "auto", padding: 20 },
    emptyText: { opacity: 0.6, fontSize: 18, textAlign: 'center' },
    row: (justify) => ({ display: "flex", justifyContent: justify, marginBottom: 10 }),
    bubble: (me, provisional) => ({
      background: me ? ACCENT : "rgba(255,255,255,0.95)",
      color: me ? "white" : "#0a0a0a",
      borderRadius: 18,
      padding: "10px 14px",
      maxWidth: "85%",
      boxShadow: "0 1px 6px rgba(0,0,0,0.06)",
      whiteSpace: "pre-wrap",
      opacity: provisional ? 0.7 : 1,          // <— dim while provisional
      fontStyle: provisional ? "italic" : "normal",
    }),
    controls: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between", // push apart
      padding: 16,
      borderTop: "1px solid rgba(0,0,0,0.08)",
    },
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
    ctaDisabled: {
      opacity: 0.5,
      cursor: "not-allowed",
      filter: "grayscale(15%)",
    },    
    status: { fontSize: 12, opacity: 0.7, display: "inline-flex", alignItems: "center", gap: 6 },
    footer: { maxWidth: 1100, width: "100%", margin: "0 auto", padding: "32px 20px", textAlign: "center", fontSize: 12, opacity: 0.6 },

    avatar: {
      width: 50,
      height: 50,
      borderRadius: "50%",
      flex: "0 0 36px",
      objectFit: "cover",
      boxShadow: "0 2px 6px rgba(0,0,0,0.12)",
      marginRight: 10,              // space between avatar and bubble
    },
    rowWithAvatar: {
      display: "flex",
      alignItems: "flex-start",
      gap: 0,
      marginBottom: 10,
    },

    input: {
      padding: "14px 16px",
      borderRadius: 20,
      minWidth: 300,
      outline: "none",                     
      transition: "border-color .15s, box-shadow .15s",
      fontWeight: 400,
      color: "#0a0a0a",
      boxShadow: "0 4px 12px rgba(0,0,0,0.12)",
      border: `1px solid ${ACCENT}`
    },
    inputFocused: {
      border: `1px solid ${ACCENT}`,       // green border
      boxShadow: `0 0 0 4px rgba(0,195,137,0.15) inset`, // soft glow
    },

    // in styles
    toggle: {
      display: "flex",
      alignItems: "center",
      border: `1px solid ${ACCENT}`,
      borderRadius: 30,
      overflow: "hidden",
      background: "#ffffff",
      position: "relative",
      boxShadow: "0 4px 12px rgba(0,0,0,0.12)",
    },
    toggleBtn: {
      flex: 1,
      minWidth: 0,
      padding: "12px 18px",      
      fontSize: 14,
      fontWeight: 600,
      border: "none",
      background: "transparent",
      color: ACCENT,
      cursor: "pointer",
      lineHeight: 1,
      textAlign: "center",
      outline: "none",
      boxShadow: "none",
    },
    toggleBtnActive: {
      background: ACCENT,
      color: "#ffffff",
    },

    toggleBtnLeftPad:  { padding: "12px 22px 12px 18px" },  // a touch more right pad
    toggleBtnRightPad: { padding: "12px 18px 12px 22px" },  // a touch more left pad

  };

  return (
    <div style={styles.page}>
      {/* Top Bar */}
      <div style={styles.topbar}>
        {/* Put your logo at public/helport.png */}
        <img src="/helport.png" alt="Helport AI" style={styles.brand} />
        <div style={styles.spacer}>Session: {sessionId || "new"} · {connected ? "Online" : "Offline"}</div>
      </div>

      {/* Hero */}
      <section style={styles.hero}>
        <motion.h1 initial={{opacity:0,y:6}} animate={{opacity:1,y:0}} style={styles.h1}>Toby Clone Bot</motion.h1>
        <motion.p initial={{opacity:0,y:6}} animate={{opacity:1,y:0}} style={styles.p}>
          Voice demo of our sales knowledge base — ask anything and hear the answer in Toby&apos;s voice.
        </motion.p>
      </section>

      {/* Card */}
      <main style={styles.cardWrap}>
        <div style={styles.card}>
          {/* Chat Scroll */}
          <div ref={scrollerRef} style={styles.scroll}>
            {messages.length === 0 ? (
              <div style={{ height: "100%", display: "grid", placeItems: "center" }}>
                <EmptyHint />
              </div>
            ) : (
              <div>
                {messages.map((m, i) => (
                  <motion.div key={m.id ?? i}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    style={m.role === "assistant" ? styles.rowWithAvatar : styles.row("flex-end")}
                  >
                    {m.role === "assistant" && <img src={AVATAR_URL} alt="Agent" style={styles.avatar} />}

                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <div style={styles.bubble(m.role === "user", m.provisional)}>
                      {m.text}
                    </div>
                    {m.role === "assistant" && !m.provisional && (
                      (playingKey === m.id && isAudioPlaying) ? (
                        <button
                          onClick={stopSpeaking}
                          title="Stop"
                          aria-label="Stop audio"
                          style={{
                            border: "none",
                            background: "transparent",
                            cursor: "pointer",
                            display: "inline-flex",
                            alignItems: "center",
                            padding: 4,
                            opacity: 0.9,
                          }}
                        >
                          <Square size={16} />
                        </button>
                      ) : (
                        <button
                          onClick={() => {
                            stopSpeaking();
                            setPlayingKey(m.id);
                            speakTextSmart(m.text, "en", { replay: true, msgId: m.id });
                          }}
                          title="Replay"
                          aria-label="Replay audio"
                          style={{
                            border: "none",
                            background: "transparent",
                            cursor: "pointer",
                            display: "inline-flex",
                            alignItems: "center",
                            padding: 4,
                            opacity: 0.7,
                          }}
                        >
                          <Volume2 size={16} />
                        </button>
                      )
                    )}

                  </div>
                  </motion.div>
                ))}
              </div>
            )}
          </div>

          {/* Controls */}
          <div style={styles.controls}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={styles.toggle} role="tablist" aria-label="Input mode">
                <button
                  role="tab"
                  aria-selected={mode === "voice"}
                  onClick={switchToVoice}
                  style={{ ...styles.toggleBtn, ...(mode === "voice" ? styles.toggleBtnActive : null) }}
                >
                  Voice
                </button>
                <div aria-hidden style={styles.toggleDivider} />
                <button
                  role="tab"
                  aria-selected={mode === "type"}
                  onClick={switchToType}
                  style={{ ...styles.toggleBtn, ...(mode === "type" ? styles.toggleBtnActive : null), ...styles.toggleBtnRightPad, ...styles.toggleBtnLeftPad }}
                >
                  Text
                </button>
              </div>
              {displayStatus && (
                <span style={styles.status}>
                  {statusIcon()}
                  {displayStatus}
                </span>
              )}
              {needsUserTap && (
                <button
                  onClick={() => { try { audioRef.current?.play(); } catch {} }}
                  style={{ marginLeft: 8, border: '1px solid ' + ACCENT, color: ACCENT, background: '#fff', borderRadius: 20, padding: '6px 10px', fontSize: 12, cursor: 'pointer' }}
                  title="Enable audio"
                >
                🔈 点击启用音频
                </button>
              )}
            </div>

            {/* Controls: either show recording CTA or text input depending on mode */}
              {mode === "voice" ? (
                <button
                  onClick={voiceCta.onClick}
                  disabled={voiceCta.disabled}
                  style={{
                    ...styles.cta(voiceCta.danger),
                    ...(voiceCta.disabled ? styles.ctaDisabled : null),
                  }}
                  aria-label={voiceCta.aria}
                >
                  {voiceCta.icon} {voiceCta.label}
                </button>
              ) : (
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  value={textInput}
                  onChange={(e) => setTextInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") sendTextMessage(); }}
                  onFocus={() => setInputFocused(true)}
                  onBlur={() => setInputFocused(false)}
                  placeholder="Type your question and press Enter"
                  style={{ ...styles.input, ...(inputFocused ? styles.inputFocused : null) }}
                />

                <button onClick={sendTextMessage} style={styles.cta(false)} aria-label="Send message">
                  <ArrowUp size={16} />
                </button>
              </div>
            )}
            <button
              onClick={newConversation}
              style={{ ...styles.cta(false), background: '#ffffff', color: ACCENT, border: `1px solid ${ACCENT}` }}
              aria-label="Start a new conversation"
            >
              New conversation
            </button>
          </div>
        </div>
      </main>

      <audio ref={audioRef} preload="auto" playsInline/>

      {/* Footer */}
      <footer style={styles.footer}>
        © {new Date().getFullYear()} Helport AI · Built for live demos · Voice: top-sales-voice-001
      </footer>
    </div>
  );
}
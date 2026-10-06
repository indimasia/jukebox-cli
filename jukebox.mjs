#!/usr/bin/env node
// Jukebox CLI: shared music queue, terminal only, audio only.
// Host:  jukebox host [--port 7777] [--limit 2] [--shuffle] [--fallback <youtube playlist url>]
// Guests scan the QR (web page) or use: jukebox join <host:port> <CODE> <name>
import http from "node:http";
import os from "node:os";
import readline from "node:readline";
import { spawn, execFile, execFileSync } from "node:child_process";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name, def) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : def;
};
// ponytail: macOS CoreAudio, else ALSA "default" (routes through PipeWire/PulseAudio on most Linux desktops). No Windows.
const AUDIO_OUT = process.platform === "darwin" ? ["-f", "audiotoolbox", "-"] : ["-f", "alsa", "default"];
const fmt = (s) => (s ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}` : "?:??");

const ytdlp = (args) =>
  new Promise((res, rej) =>
    execFile("yt-dlp", args, { maxBuffer: 1 << 24 }, (err, out, errOut) =>
      err ? rej(new Error(errOut.trim().split("\n").pop() || err.message)) : res(out.trim()),
    ),
  );

const known = new Map(); // ponytail: id -> song from searches, never pruned; fine for one party
const parse = (out, user) =>
  out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [id, title, d] = l.split("\t");
      return { id, title, secs: +d || 0, user };
    });

// Search query -> top 5 results, YouTube URL -> that one video.
async function search(q) {
  q = (q || "").trim();
  if (!q) throw new Error("empty search");
  const isUrl = /^https?:\/\//.test(q);
  const out = await ytdlp([
    isUrl ? "--no-playlist" : "--flat-playlist",
    "--print",
    "%(id)s\t%(title)s\t%(duration)s",
    "--",
    isUrl ? q : `ytsearch5:${q}`,
  ]);
  const songs = parse(out);
  if (!songs.length) throw new Error("nothing found");
  songs.forEach((s) => known.set(s.id, s));
  return songs;
}

async function host() {
  const port = +flag("port", 7777);
  const limit = +flag("limit", 2);
  const code = Math.random().toString(36).slice(2, 7).toUpperCase();
  const queue = []; // {id,title,secs,user}
  const lastPlayed = {}; // user -> timestamp, for round-robin fairness
  const events = [];
  const say = (m) => events.push(m) > 6 && events.shift();
  let shuffle = rest.includes("--shuffle");
  let view = "qr"; // or "viz"
  let fallback = [];
  let fallbackPos = 0;
  let now = null;
  let startedAt = 0;
  let player = null;

  if (flag("fallback")) fallback = parse(await ytdlp(["--flat-playlist", "--print", "%(id)s\t%(title)s\t%(duration)s", "--", flag("fallback")]), "fallback");

  const add = (user, song) => {
    if (queue.filter((s) => s.user === user).length >= limit) throw new Error(`limit of ${limit} queued songs reached`);
    queue.push({ ...song, user });
    say(`+ ${user} queued ${song.title}`);
    if (!player) playNext();
    return song;
  };

  const rand = (n) => Math.floor(Math.random() * n);
  // Next song = queued song whose user played least recently (or random in shuffle mode).
  // Guests always beat fallback.
  const pickNext = () => {
    if (!queue.length) {
      if (!fallback.length) return null;
      return shuffle ? fallback[rand(fallback.length)] : fallback[fallbackPos++ % fallback.length];
    }
    if (shuffle) return queue.splice(rand(queue.length), 1)[0];
    let best = 0;
    queue.forEach((s, i) => {
      if ((lastPlayed[s.user] ?? 0) < (lastPlayed[queue[best].user] ?? 0)) best = i;
    });
    return queue.splice(best, 1)[0];
  };

  // Last N mono samples of what is playing, for the visualizer.
  const N = 2048;
  const ring = new Float32Array(N);
  let ringPos = 0;
  const feed = (buf) => {
    for (let i = 0; i + 3 < buf.length; i += 4) {
      ring[ringPos] = (buf.readInt16LE(i) + buf.readInt16LE(i + 2)) / 65536;
      ringPos = (ringPos + 1) % N;
    }
  };

  function playNext() {
    ring.fill(0);
    now = pickNext();
    if (!now) return (player = null);
    lastPlayed[now.user] = Date.now();
    startedAt = Date.now();
    // yt-dlp -> ffmpeg decodes to raw PCM at real-time speed -> we tap it for the visualizer -> ffmpeg plays it on the system's default output.
    const dl = spawn("yt-dlp", ["-q", "-f", "bestaudio", "-o", "-", "--", `https://youtu.be/${now.id}`], { stdio: ["ignore", "pipe", "ignore"] });
    const dec = spawn("ffmpeg", ["-loglevel", "quiet", "-re", "-i", "-", "-f", "s16le", "-ac", "2", "-ar", "44100", "-"], { stdio: ["pipe", "pipe", "ignore"] });
    const out = spawn("ffmpeg", ["-loglevel", "quiet", "-f", "s16le", "-ar", "44100", "-ac", "2", "-i", "-", ...AUDIO_OUT], { stdio: ["pipe", "ignore", "ignore"] });
    dl.stdout.pipe(dec.stdin);
    dec.stdout.on("data", (buf) => (feed(buf), out.stdin.write(buf)));
    dec.stdout.on("end", () => out.stdin.end());
    dec.stdin.on("error", () => {}); // EPIPE on skip
    out.stdin.on("error", () => {});
    const procs = [dl, dec, out];
    player = { kill: () => procs.forEach((p) => p.kill()) };
    out.on("exit", () => {
      procs.forEach((p) => p.kill());
      playNext();
    });
  }

  const status = () =>
    [
      (now ? `▶ ${now.title} [${fmt(now.secs)}] — ${now.user}` : "(nothing playing)") + (shuffle ? "  [shuffle]" : ""),
      ...queue.map((s, i) => `${i + 1}. ${s.title} [${fmt(s.secs)}] — ${s.user}`),
    ].join("\n");

  http
    .createServer(async (req, res) => {
      const url = new URL(req.url, "http://x");
      const p = Object.fromEntries(url.searchParams);
      if (url.pathname === "/") return res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
      if (p.code?.toUpperCase() !== code) return res.writeHead(403).end("wrong room code\n");
      try {
        if (url.pathname === "/search") return res.end(JSON.stringify(await search(p.q)));
        if (url.pathname === "/add") {
          const song = known.get(p.id) ?? (p.q && (await search(p.q))[0]);
          if (!song) throw new Error("unknown song, search first");
          add((p.user || "guest").slice(0, 20), song);
          return res.end(`queued: ${song.title} [${fmt(song.secs)}]\n`);
        }
        if (url.pathname === "/queue") return res.end(status() + "\n");
        res.writeHead(404).end("not found\n");
      } catch (e) {
        res.writeHead(400).end(`error: ${e.message}\n`);
      }
    })
    .listen(port);

  const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i.family === "IPv4" && !i.internal).map((i) => i.address);
  const web = `http://${ips[0] ?? "localhost"}:${port}/?code=${code}`;
  let qr = ["(install qrencode to show a QR code)"];
  try {
    qr = execFileSync("qrencode", ["-t", "UTF8", "-m", "1", web]).toString().split("\n").filter(Boolean);
  } catch {}
  if (fallback.length) playNext();

  // ---- live full-screen UI ----
  const vis = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const pad = (s, w) => s + " ".repeat(Math.max(0, w - [...vis(s)].length));
  const cut = (s, w) => ([...s].length > w ? [...s].slice(0, Math.max(0, w - 1)).join("") + "…" : s);
  const c = (n, s) => `\x1b[38;5;${n}m${s}\x1b[0m`;
  const bold = (s) => `\x1b[1m${s}\x1b[0m`;
  const LW = Math.max([...qr[0]].length, 34);
  const H = Math.max(qr.length, 14);

  // Spectrum: magnitude at log-spaced frequencies (40Hz..16kHz) via single-bin DFT, auto-gain in dB.
  const bars = new Array(64).fill(0);
  let topDb = -20;
  function viz(n, h) {
    let max = -120;
    const levels = [];
    for (let b = 0; b < n; b++) {
      const f = 40 * Math.pow(400, b / (n - 1));
      const w = (2 * Math.PI * f) / 44100;
      let re = 0, im = 0;
      for (let i = 0; i < N; i++) {
        const x = ring[(ringPos + i) % N] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
        re += x * Math.cos(w * i);
        im -= x * Math.sin(w * i);
      }
      const db = 20 * Math.log10(Math.hypot(re, im) + 1e-9) + 4.5 * Math.log2(f / 40); // tilt so highs show up
      max = Math.max(max, db);
      levels.push(db);
    }
    topDb = Math.max(max, topDb - 0.3);
    levels.forEach((db, b) => (bars[b] = Math.max(Math.min(1, Math.max(0, (db - topDb + 40) / 40)), bars[b] * 0.82)));
    const colors = [93, 99, 135, 171, 207, 213];
    const rows = [];
    for (let r = 0; r < h; r++) {
      const lvl = h - 1 - r;
      const line = bars
        .slice(0, n)
        .map((v) => " ▁▂▃▄▅▆▇█"[Math.min(8, Math.max(0, Math.round(v * h * 8) - lvl * 8))].repeat(2))
        .join(" ");
      rows.push(c(colors[Math.floor((lvl / h) * colors.length)], line));
    }
    return rows;
  }

  let input = "";
  function render() {
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    const left =
      view === "qr"
        ? [...qr, "", "  scan to add songs"]
        : [...viz(Math.floor(LW / 3), H - 2), "", c(245, cut(web, LW))];
    const narrow = cols < LW + 30;
    const RW = narrow ? cols : cols - LW - 3;
    const elapsed = now ? (Date.now() - startedAt) / 1000 : 0;
    const pw = Math.max(10, RW - 14);
    const done = now?.secs ? Math.min(pw, Math.round((elapsed / now.secs) * pw)) : 0;
    const right = [
      bold(c(213, "♫ Jukebox")) + `  room ${bold(code)}` + (shuffle ? c(171, "  ⤨ shuffle") : ""),
      c(245, cut(web, RW)),
      "",
      now ? bold(cut(`▶ ${now.title}`, RW)) : c(245, "nothing playing — add a song"),
      now ? c(245, cut(`  added by ${now.user}`, RW)) : "",
      now ? c(171, "━".repeat(done)) + c(238, "━".repeat(pw - done)) + ` ${fmt(elapsed)}/${fmt(now.secs)}` : "",
      "",
      bold("Up next"),
      ...(queue.length ? queue.map((s, i) => cut(`${i + 1}. ${s.title} — ${s.user}`, RW)) : [c(245, fallback.length ? "  (fallback playlist)" : "  (empty)")]),
      "",
      ...events.map((e) => c(245, cut(e, RW))),
    ];
    const body = narrow ? [...left, "", ...right] : Array.from({ length: Math.max(left.length, right.length) }, (_, i) => pad(left[i] ?? "", LW) + "   " + (right[i] ?? ""));
    const lines = body.slice(0, rows - 2);
    while (lines.length < rows - 2) lines.push("");
    lines.push(c(245, cut("<song> add · s skip · r shuffle · v/tab visualizer · q quit", cols)));
    process.stdout.write("\x1b[H" + lines.map((l) => l + "\x1b[K").join("\r\n") + "\r\n" + cut(`> ${input}`, cols) + "\x1b[K");
  }

  const quit = () => (player?.kill(), process.exit(0));
  const command = (line) => {
    if (line === "q") quit();
    else if (line === "s") player?.kill();
    else if (line === "r") say(`shuffle ${(shuffle = !shuffle) ? "on" : "off"}`);
    else if (line === "v") view = view === "qr" ? "viz" : "qr";
    else if (line)
      search(line)
        .then(([s]) => add("host", s))
        .catch((e) => say(`! ${e.message}`));
  };

  process.stdout.write("\x1b[?1049h\x1b[2J");
  process.on("exit", () => process.stdout.write("\x1b[?1049l"));
  process.stdout.on("resize", () => process.stdout.write("\x1b[2J"));
  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.on("keypress", (ch, key) => {
      if (key?.ctrl && key.name === "c") quit();
      else if (key?.name === "return") (command(input.trim()), (input = ""));
      else if (key?.name === "backspace") input = input.slice(0, -1);
      else if (key?.name === "tab") view = view === "qr" ? "viz" : "qr";
      else if (ch && !key?.ctrl && !key?.meta && ch >= " ") input += ch;
      render();
    });
  } else readline.createInterface({ input: process.stdin }).on("line", (l) => command(l.trim()));
  (function loop() {
    render();
    setTimeout(loop, view === "viz" ? 50 : 500);
  })();
}

async function join() {
  const [addr, code, user = os.userInfo().username] = rest;
  if (!addr || !code) return console.log("usage: jukebox join <host:port> <CODE> [name]");
  const call = async (path, params = {}) => {
    const qs = new URLSearchParams({ code, user, ...params });
    try {
      return await (await fetch(`http://${addr}${path}?${qs}`)).text();
    } catch (e) {
      return `error: ${e.cause?.code ?? e.message}\n`;
    }
  };
  process.stdout.write(await call("/queue"));
  console.log("commands: <song name or url> search | l list | q quit");
  let results = null;
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    line = line.trim();
    if (results) {
      const s = results[+line - 1];
      results = null;
      return s ? process.stdout.write(await call("/add", { id: s.id })) : console.log("cancelled");
    }
    if (line === "q") process.exit(0);
    if (line === "l") return process.stdout.write(await call("/queue"));
    if (!line) return;
    const r = await call("/search", { q: line });
    try {
      results = JSON.parse(r);
    } catch {
      return process.stdout.write(r);
    }
    results.forEach((s, i) => console.log(`${i + 1}. ${s.title} [${fmt(s.secs)}]`));
    console.log("pick a number (enter to cancel):");
  });
}

// Guest web page. Room code comes from the QR link (?code=...).
const PAGE = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Jukebox</title>
<style>
body{font:16px system-ui;padding:16px;background:#111;color:#eee;max-width:560px;margin:auto}
input,button{font:inherit;padding:12px;border-radius:8px;border:1px solid #444;background:#222;color:#eee;width:100%;box-sizing:border-box;margin:4px 0}
button{background:#7c3aed;border:0;font-weight:600;cursor:pointer}
pre{white-space:pre-wrap;background:#1b1b1b;padding:12px;border-radius:8px}
#msg{min-height:1.4em;color:#a78bfa}
.r{display:flex;gap:10px;align-items:center;background:#1b1b1b;border-radius:8px;padding:8px;margin:6px 0}
.r img{width:96px;border-radius:6px}
.r div{flex:1;min-width:0}
.r small{color:#999}
.r button{width:auto;padding:8px 14px}
</style>
<h1>🎶 Jukebox</h1>
<form id=f>
<input id=user placeholder="Your name" required maxlength=20>
<input id=q placeholder="Song name or YouTube link" required>
<button>Search</button>
</form>
<div id=msg></div>
<div id=results></div>
<h3>Queue</h3><pre id=list>loading…</pre>
<script>
const code = new URLSearchParams(location.search).get("code") || prompt("Room code");
const $ = (id) => document.getElementById(id);
const user = $("user"), q = $("q"), msg = $("msg"), results = $("results");
try { user.value = localStorage.name || "" } catch {}
const call = (path, extra) => fetch(path + "?" + new URLSearchParams(Object.assign({ code: code, user: user.value }, extra)));
const fmt = (s) => s ? Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0") : "";
const refresh = async () => $("list").textContent = await (await call("/queue")).text();
$("f").onsubmit = async (e) => {
  e.preventDefault();
  try { localStorage.name = user.value } catch {}
  msg.textContent = "searching…";
  results.replaceChildren();
  const r = await call("/search", { q: q.value });
  if (!r.ok) return msg.textContent = await r.text();
  msg.textContent = "pick a song:";
  for (const s of await r.json()) {
    const row = document.createElement("div"); row.className = "r";
    const img = document.createElement("img"); img.src = "https://i.ytimg.com/vi/" + s.id + "/mqdefault.jpg";
    const info = document.createElement("div");
    const t = document.createElement("div"); t.textContent = s.title;
    const d = document.createElement("small"); d.textContent = fmt(s.secs);
    const b = document.createElement("button"); b.textContent = "Add";
    b.onclick = async () => {
      msg.textContent = await (await call("/add", { id: s.id })).text();
      results.replaceChildren(); q.value = ""; refresh();
    };
    info.append(t, d); row.append(img, info, b); results.append(row);
  }
};
refresh(); setInterval(refresh, 5000);
</script>`;

if (cmd === "host") host();
else if (cmd === "join") join();
else console.log("usage:\n  jukebox host [--port 7777] [--limit 2] [--shuffle] [--fallback <playlist url>]\n  jukebox join <host:port> <CODE> [name]");

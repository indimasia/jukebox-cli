#!/usr/bin/env node
// Jukebox CLI: shared music queue, terminal only, audio only.
// Host:  jukebox host [--port 7777] [--limit 2] [--shuffle] [--tunnel] [--stacked] [--cookies <browser|cookies.txt>] [--fallback <youtube playlist url>]
// Guests scan the QR (web page) or use: jukebox join <host:port> <CODE> <name>
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

// YouTube "Sign in to confirm you're not a bot".
// --cookies <browser> (chrome, firefox, safari...) reads that browser on THIS machine.
// Over SSH the browser isn't there, so export a cookies.txt locally and copy it over:
//   yt-dlp --cookies-from-browser chrome --cookies cookies.txt -- "https://youtu.be/dQw4w9WgXcQ"
//   scp cookies.txt user@jukebox-host:~/
// then: jukebox host --cookies ~/cookies.txt
const BROWSERS = new Set(["brave", "chrome", "chromium", "edge", "firefox", "opera", "safari", "vivaldi", "whale"]);
const cookieFlag = flag("cookies");
const looksLikeFile = cookieFlag && (cookieFlag.includes("/") || /\.(txt|cookies?)$/i.test(cookieFlag) || (!BROWSERS.has(cookieFlag.split(":")[0].toLowerCase()) && fs.existsSync(cookieFlag)));
const COOKIE_PATH = looksLikeFile ? cookieFlag.replace(/^~(?=\/|$)/, os.homedir()) : null;
if (cookieFlag && looksLikeFile && !fs.existsSync(COOKIE_PATH)) {
  console.error(`--cookies file not found: ${COOKIE_PATH}`);
  process.exit(1);
}
const COOKIES = !cookieFlag ? [] : COOKIE_PATH ? ["--cookies", COOKIE_PATH] : ["--cookies-from-browser", cookieFlag];
const YT_HINT = " (YouTube bot-check? host needs --cookies: export cookies.txt locally, scp it to the host, run --cookies ~/cookies.txt)";
const ytdlp = (args) =>
  new Promise((res, rej) =>
    execFile("yt-dlp", [...COOKIES, ...args], { maxBuffer: 1 << 24 }, (err, out, errOut) => {
      if (err) {
        const last = errOut.trim().split("\n").pop() || err.message;
        rej(new Error(/sign in|bot|cookie|403|401|login/i.test(last) ? last + YT_HINT : last));
      } else res(out.trim());
    }),
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
  const HEADLESS = !process.stdout.isTTY;
  const say = (m) => {
    events.push(m) > 6 && events.shift();
    if (HEADLESS) console.log(m);
  };
  let shuffle = rest.includes("--shuffle");
  let view = "qr"; // or "viz"
  let layout = rest.includes("--stacked") ? "stack" : "side"; // side-by-side or top/bottom
  let fallback = [];
  let fallbackPos = 0;
  let now = null;
  let startedAt = 0;
  let player = null;
  let pausedAt = null; // seconds into the song while paused, else null

  if (flag("fallback")) fallback = parse(await ytdlp(["--flat-playlist", "--print", "%(id)s\t%(title)s\t%(duration)s", "--", flag("fallback")]), "fallback");
  if (cookieFlag && !COOKIE_PATH && (process.env.SSH_CONNECTION || process.env.SSH_CLIENT))
    say("! SSH session: --cookies <browser> can't see your laptop's browser, use --cookies ~/cookies.txt");

  const add = (user, song) => {
    if (queue.filter((s) => s.user === user).length >= limit) throw new Error(`limit of ${limit} queued songs reached`);
    queue.push({ ...song, user });
    say(`+ ${user} queued ${song.title}`);
    if (!now) playNext();
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
    return queue.splice(queue.indexOf(upcoming()[0]), 1)[0];
  };
  // Queue in the order it will play: simulate fair turns. In shuffle mode the order is unknown, so show as added.
  const upcoming = () => {
    if (shuffle) return queue;
    const q = [...queue], lp = { ...lastPlayed }, out = [];
    let t = Date.now();
    while (q.length) {
      let best = 0;
      q.forEach((s, i) => {
        if ((lp[s.user] ?? 0) < (lp[q[best].user] ?? 0)) best = i;
      });
      const [s] = q.splice(best, 1);
      lp[s.user] = ++t;
      out.push(s);
    }
    return out;
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

  const elapsed = () => (pausedAt ?? (Date.now() - startedAt) / 1000);

  function playNext() {
    pausedAt = null;
    now = pickNext();
    if (!now) return (player = null);
    lastPlayed[now.user] = Date.now();
    download(now);
    start(0);
  }

  // The current song's audio is kept in memory as it downloads, so pause/resume never hits YouTube again.
  // ponytail: whole song in RAM (~4-10MB per song), only the current one.
  let song = null; // { chunks, done, dl, sink }
  function download(s, attempt = 0, cur) {
    // retries reuse `cur` so the running decoder stays wired to the new yt-dlp
    if (!cur) (song?.dl?.kill(), (cur = song = { chunks: [], done: false, dl: null, sink: null }));
    // bestaudio (opus 251) 403s on some videos without a GVS PO token;
    // walk down: m4a 140, legacy progressive mp4 18 (audio in video file),
    // then anything. 18 has worked even with no cookies at all.
    const formats = ["bestaudio", "140/best[acodec^=mp4a]/bestaudio", "18/best[ext=mp4]/best"];
    const fmt = formats[Math.min(attempt, formats.length - 1)];
    const dl = spawn("yt-dlp", [...COOKIES, "--no-progress", "-f", fmt, "-o", "-", "--", `https://youtu.be/${s.id}`], { stdio: ["ignore", "pipe", "pipe"] });
    cur.dl = dl;
    let errOut = "";
    dl.stderr.on("data", (b) => (errOut += b));
    dl.stdout.on("data", (b) => (cur.chunks.push(b), cur.sink?.write(b)));
    dl.on("close", (code) => {
      if (song !== cur) return;
      if (code && !cur.chunks.length) {
        if (attempt + 1 < formats.length) return download(s, attempt + 1, cur);
        const last = errOut.trim().split("\n").pop() || "YouTube refused the download";
        say(`! "${s.title}" skipped: ${/sign in|bot|cookie|403|401|login/i.test(last) ? last + YT_HINT : last}`.slice(0, 200));
      }
      // empty input makes the decoder exit, which advances the queue
      cur.done = true;
      cur.sink?.end();
    });
  }

  // Pause stops playback and remembers the position; play restarts decoding from memory at that spot (ffmpeg -ss).
  const pause = () => {
    if (!now || pausedAt != null) return;
    pausedAt = elapsed();
    player.stop();
    ring.fill(0);
    say("⏸ paused");
  };
  const resume = () => {
    if (pausedAt == null) return;
    const at = pausedAt;
    pausedAt = null;
    start(at);
    say("▶ resumed");
  };

  function start(at) {
    ring.fill(0);
    startedAt = Date.now() - at * 1000;
    // song bytes -> ffmpeg decodes to raw PCM at real-time speed -> we tap it for the visualizer -> ffmpeg plays it on the system's default output.
    const dec = spawn("ffmpeg", ["-loglevel", "quiet", "-re", ...(at ? ["-ss", String(at)] : []), "-i", "-", "-f", "s16le", "-ac", "2", "-ar", "44100", "-"], { stdio: ["pipe", "pipe", "ignore"] });
    const out = spawn("ffmpeg", ["-loglevel", "quiet", "-f", "s16le", "-ar", "44100", "-ac", "2", "-i", "-", ...AUDIO_OUT], { stdio: ["pipe", "ignore", "ignore"] });
    dec.stdin.on("error", () => {}); // EPIPE on skip/pause
    out.stdin.on("error", () => {});
    for (const b of song.chunks) dec.stdin.write(b);
    if (song.done) dec.stdin.end();
    else song.sink = dec.stdin;
    dec.stdout.on("data", (buf) => (feed(buf), out.stdin.write(buf)));
    dec.stdout.on("end", () => out.stdin.end());
    let stopped = false;
    const halt = () => {
      if (song.sink === dec.stdin) song.sink = null;
      dec.kill();
      out.kill();
    };
    // kill = skip (moves to next song), stop = pause (stays on this song)
    player = { kill: halt, stop: () => ((stopped = true), halt()) };
    out.on("exit", () => {
      halt();
      if (!stopped) playNext();
    });
  }

  const status = () =>
    [
      (now ? `${pausedAt != null ? "⏸" : "▶"} ${now.title} [${fmt(now.secs)}] — ${now.user}` : "(nothing playing)") + (shuffle ? "  [shuffle]" : ""),
      ...upcoming().map((s, i) => `${i + 1}. ${s.title} [${fmt(s.secs)}] — ${s.user}`),
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
        if (url.pathname === "/state")
          return res.end(JSON.stringify({ now: now && { ...now, elapsed: elapsed() }, paused: pausedAt != null, queue: upcoming(), shuffle }));
        res.writeHead(404).end("not found\n");
      } catch (e) {
        res.writeHead(400).end(`error: ${e.message}\n`);
      }
    })
    .on("error", (e) => {
      process.stdout.write("\x1b[?1049l");
      console.error(e.code === "EADDRINUSE" ? `port ${port} is in use (another jukebox running?), try --port ${port + 1}` : e.message);
      process.exit(1);
    })
    .listen(port);

  const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i.family === "IPv4" && !i.internal).map((i) => i.address);
  let base = `http://${ips[0] ?? "localhost"}:${port}`;
  let tunnel = null;
  if (rest.includes("--tunnel")) {
    // Cloudflare quick tunnel: free public https URL, no account. Guests can join from any network.
    console.log("starting tunnel…");
    tunnel = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://localhost:${port}`], { stdio: ["ignore", "ignore", "pipe"] });
    base = await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("tunnel did not start within 30s")), 30000);
      tunnel.on("error", () => rej(new Error("cloudflared not found, install it: https://github.com/cloudflare/cloudflared")));
      tunnel.stderr.on("data", (d) => {
        const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (m) clearTimeout(t), res(m[0]);
      });
    }).catch((e) => (console.error(e.message), process.exit(1)));
    process.on("exit", () => tunnel.kill());
  }
  const web = `${base}/?code=${code}`;
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
  const bars = new Array(96).fill(0);
  const hann = Float32Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  let topDb = -20;
  function viz(n, h) {
    let max = -120;
    const levels = [];
    for (let b = 0; b < n; b++) {
      const f = 40 * Math.pow(400, b / (n - 1));
      const w = (2 * Math.PI * f) / 44100;
      // Rotate a unit phasor instead of calling cos/sin per sample.
      const cw = Math.cos(w), sw = Math.sin(w);
      let re = 0, im = 0, pc = 1, ps = 0;
      for (let i = 0; i < N; i++) {
        const x = ring[(ringPos + i) % N] * hann[i];
        re += x * pc;
        im -= x * ps;
        [pc, ps] = [pc * cw - ps * sw, pc * sw + ps * cw];
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
    const stacked = layout === "stack" || cols < LW + 30;
    const center = (l, w) => " ".repeat(Math.max(0, Math.floor((cols - w) / 2))) + l;
    const left = stacked
      ? view === "qr"
        ? [...qr.map((l) => center(l, [...qr[0]].length)), center("scan to add songs", 17)]
        : viz(Math.min(bars.length, Math.floor(cols / 3)), Math.max(6, Math.floor(rows * 0.45)))
      : view === "qr"
        ? [...qr, "", "  scan to add songs"]
        : [...viz(Math.floor(LW / 3), H - 2), "", c(245, cut(web, LW))];
    const RW = stacked ? cols : cols - LW - 3;
    const pos = now ? elapsed() : 0;
    const pw = Math.max(10, RW - 14);
    const done = now?.secs ? Math.min(pw, Math.round((pos / now.secs) * pw)) : 0;
    const right = [
      bold(c(213, "♫ Jukebox")) + `  room ${bold(code)}` + (shuffle ? c(171, "  ⤨ shuffle") : ""),
      c(245, cut(web, RW)),
      "",
      now ? bold(cut(`${pausedAt != null ? "⏸" : "▶"} ${now.title}`, RW)) : c(245, "nothing playing — add a song"),
      now ? c(245, cut(`  added by ${now.user}`, RW)) : "",
      now ? c(171, "━".repeat(done)) + c(238, "━".repeat(pw - done)) + ` ${fmt(pos)}/${fmt(now.secs)}` : "",
      "",
      bold("Up next"),
      ...(queue.length ? upcoming().map((s, i) => cut(`${i + 1}. ${s.title} — ${s.user}`, RW)) : [c(245, fallback.length ? "  (fallback playlist)" : "  (empty)")]),
      "",
      ...events.map((e) => c(245, cut(e, RW))),
    ];
    const body = stacked ? [...left, "", ...right] : Array.from({ length: Math.max(left.length, right.length) }, (_, i) => pad(left[i] ?? "", LW) + "   " + (right[i] ?? ""));
    const lines = body.slice(0, rows - 2);
    while (lines.length < rows - 2) lines.push("");
    lines.push(c(245, cut("<song> add · p/space pause · s skip · r shuffle · v/tab visualizer · t layout · q quit", cols)));
    process.stdout.write("\x1b[H" + lines.map((l) => l + "\x1b[K").join("\r\n") + "\r\n" + cut(`> ${input}`, cols) + "\x1b[K");
  }

  const quit = () => (song?.dl.kill(), player?.kill(), process.exit(0));
  const command = (line) => {
    if (line === "q") quit();
    else if (line === "s") pausedAt != null ? playNext() : player?.kill();
    else if (line === "p") pausedAt != null ? resume() : pause();
    else if (line === "r") say(`shuffle ${(shuffle = !shuffle) ? "on" : "off"}`);
    else if (line === "v") view = view === "qr" ? "viz" : "qr";
    else if (line === "t") (layout = layout === "side" ? "stack" : "side"), process.stdout.write("\x1b[2J");
    else if (line)
      search(line)
        .then(([s]) => add("host", s))
        .catch((e) => say(`! ${e.message}`));
  };

  process.stdout.write("\x1b[?1049h\x1b[2J");
  process.on("exit", () => process.stdout.write("\x1b[?1049l"));
  if (!HEADLESS) {
    process.stdout.on("resize", () => process.stdout.write("\x1b[2J"));
    if (process.stdin.isTTY) {
      readline.emitKeypressEvents(process.stdin);
      process.stdin.setRawMode(true);
      process.stdin.on("keypress", (ch, key) => {
        if (key?.ctrl && key.name === "c") quit();
        else if (key?.name === "return") (command(input.trim()), (input = ""));
        else if (key?.name === "backspace") input = input.slice(0, -1);
        else if (key?.name === "tab") view = view === "qr" ? "viz" : "qr";
        else if (key?.name === "space" && !input) command("p");
        else if (ch && !key?.ctrl && !key?.meta && ch >= " ") input += ch;
        render();
      });
    } else if (!process.stdin.destroyed) {
      readline
        .createInterface({ input: process.stdin })
        .on("line", (l) => command(l.trim()))
        .on("error", () => {});
      process.stdin.on("error", () => {});
    }
    (function loop() {
      render();
      setTimeout(loop, view === "viz" ? 50 : 500);
    })();
  } else {
    process.stdout.write("\x1b[?1049l");
    console.log(`jukebox up: room ${code} on port ${port}`);
    if (web) console.log(`join: ${web}`);
  }
}

async function join() {
  const [addr, code, user = os.userInfo().username] = rest;
  if (!addr || !code) return console.log("usage: jukebox join <host:port> <CODE> [name]");
  const call = async (path, params = {}) => {
    const qs = new URLSearchParams({ code, user, ...params });
    try {
      return await (await fetch(`${/^https?:\/\//.test(addr) ? addr : `http://${addr}`}${path}?${qs}`)).text();
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
.card{display:flex;gap:12px;align-items:center;background:#1b1b1b;border-radius:12px;padding:10px;margin:8px 0}
.card img{width:96px;aspect-ratio:16/9;object-fit:cover;border-radius:8px;flex:none}
.card .t{font-weight:600;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.card small{color:#999}
.card.now{background:linear-gradient(135deg,#3b1d6e,#1b1b1b);border:1px solid #7c3aed}
.card.now img{width:120px}
.badge{font-size:12px;color:#c4b5fd;text-transform:uppercase;letter-spacing:.05em}
.bar{height:4px;background:#333;border-radius:2px;margin-top:6px;overflow:hidden}
.bar i{display:block;height:100%;background:#a78bfa}
.n{color:#666;font-weight:700;width:1.5em;text-align:center;flex:none}
.empty{color:#777;padding:8px}
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
<div id=now></div>
<h3>Up next</h3><div id=list><div class=empty>loading…</div></div>
<script>
const code = new URLSearchParams(location.search).get("code") || prompt("Room code");
const $ = (id) => document.getElementById(id);
const user = $("user"), q = $("q"), msg = $("msg"), results = $("results");
try { user.value = localStorage.name || "" } catch {}
const call = (path, extra) => fetch(path + "?" + new URLSearchParams(Object.assign({ code: code, user: user.value }, extra)));
const fmt = (s) => s ? Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0") : "";
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const card = (s, extra) => {
  const c = el("div", "card");
  const img = el("img"); img.src = "https://i.ytimg.com/vi/" + s.id + "/mqdefault.jpg"; img.alt = "";
  const info = el("div"); info.style.minWidth = "0"; info.style.flex = "1";
  info.append(el("div", "t", s.title), el("small", "", "added by " + s.user + (s.secs ? " · " + fmt(s.secs) : "")));
  if (extra) extra(c, info);
  c.append(img, info);
  return c;
};
let state = null, fetchedAt = 0;
const drawNow = () => {
  const box = $("now");
  if (!state || !state.now) return box.replaceChildren(el("div", "empty", "Nothing playing. Add a song!"));
  const s = state.now, elapsed = s.elapsed + (state.paused ? 0 : (Date.now() - fetchedAt) / 1000);
  box.replaceChildren(card(s, (c, info) => {
    c.classList.add("now");
    info.prepend(el("div", "badge", (state.paused ? "⏸ Paused" : "▶ Now playing") + (state.shuffle ? " · shuffle" : "")));
    const bar = el("div", "bar"), fill = el("i");
    fill.style.width = s.secs ? Math.min(100, elapsed / s.secs * 100) + "%" : "0";
    bar.append(fill); info.append(bar);
  }));
};
const refresh = async () => {
  const r = await call("/state");
  if (!r.ok) return $("list").replaceChildren(el("div", "empty", await r.text()));
  state = await r.json(); fetchedAt = Date.now();
  drawNow();
  $("list").replaceChildren(...(state.queue.length
    ? state.queue.map((s, i) => card(s, (c) => c.prepend(el("div", "n", i + 1))))
    : [el("div", "empty", "Queue is empty")]));
};
setInterval(drawNow, 1000);
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
refresh(); setInterval(refresh, 3000);
</script>`;

if (cmd === "host") host();
else if (cmd === "join") join();
else if (cmd === "cookies") cookies();
else if (cmd === "doctor") doctor();
else console.log("usage:\n  jukebox host [--port 7777] [--limit 2] [--shuffle] [--tunnel] [--stacked] [--cookies <browser|cookies.txt>] [--fallback <playlist url>]\n  jukebox cookies [<browser>] [--out <cookies.txt>]\n  jukebox doctor [--cookies <browser|cookies.txt>]\n  jukebox join <host:port | https://url> <CODE> [name]");

// Dump this machine's browser cookies to a Netscape cookies.txt file.
// Run it ON the machine with the GUI browser (the jukebox host itself, or
// your laptop then scp the file over). Uses yt-dlp --cookies-from-browser,
// then verifies the file with a quick YouTube lookup.
function cookies() {
  const dir = path.join(os.homedir(), ".config", "jukebox");
  const want = rest.find((a) => !a.startsWith("--") && a !== "cookies");
  const out = flag("out", want?.includes("/") || want?.endsWith(".txt") ? want : path.join(dir, "cookies.txt"));
  const browser = want && !want.includes("/") && !want.endsWith(".txt") ? want : detectBrowser();
  if (!browser) {
    console.error("no supported browser profile found (looked for chrome, chromium, firefox, brave, edge, opera, vivaldi).\nLog into YouTube in a browser on this machine first, or pass one explicitly: jukebox cookies firefox");
    process.exit(1);
  }
  console.log(`reading cookies from ${browser}...`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  try {
    execFileSync("yt-dlp", ["--cookies-from-browser", browser, "--cookies", out, "--skip-download", "--print", "title", "--", "https://youtu.be/dQw4w9WgXcQ"], { stdio: "pipe" });
  } catch (e) {
    console.error(`failed to read ${browser} cookies. Is the browser running? (quit it and retry)\n${String(e.stderr ?? e.message).trim().split("\n").pop()}`);
    process.exit(1);
  }
  const yt = Number(execFileSync("grep", ["-c", "youtube", out]).toString().trim());
  console.log(`wrote ${out} (${yt} YouTube cookies) — use: jukebox host --cookies ${out}`);
}

function detectBrowser() {
  const home = os.homedir();
  const has = (p) => fs.existsSync(path.join(home, p));
  for (const [name, dir] of [
    ["chrome", ".config/google-chrome"],
    ["chromium", ".config/chromium"],
    ["brave", ".config/BraveSoftware/Brave-Browser"],
    ["firefox", ".mozilla/firefox"],
    ["firefox", ".config/mozilla/firefox"],
    ["firefox", "Library/Application Support/Firefox"],
    ["edge", ".config/microsoft-edge"],
    ["opera", ".config/opera"],
    ["vivaldi", ".config/vivaldi"],
    ["safari", "Library/Cookies"],
  ])
    if (has(dir)) return name;
  return null;
}

// Diagnose why songs won't play. Each check prints ok or FAIL with the fix.
// Run: jukebox doctor [--cookies <browser|cookies.txt>]
async function doctor() {
  let failed = 0;
  const ok = (name) => console.log(`ok   ${name}`);
  const fail = (name, fix) => (failed++, console.log(`FAIL ${name}\n     fix: ${fix}`));
  const run = (bin, args) => {
    try {
      return { out: execFileSync(bin, args, { stdio: "pipe" }).toString().trim() };
    } catch (e) {
      const text = String(e.stderr ?? e.message).replace(/\r[^\n]*/g, "").trim();
      return { err: text.split("\n").filter(Boolean).pop() };
    }
  };

  // 1. required tools
  const tools = { "yt-dlp": "--version", ffmpeg: "-version", node: "--version" };
  for (const [bin, v] of Object.entries(tools)) {
    const r = run(bin, [v]);
    r.err ? fail(`${bin} missing (${r.err})`, `install ${bin}, then re-run install.sh`) : ok(`${bin} ${r.out.split("\n")[0].slice(0, 40)}`);
  }

  // 2. resolve --cookies the same way host does
  const cf = flag("cookies") ?? path.join(os.homedir(), ".config", "jukebox", "cookies.txt");
  const isFile = cf.includes("/") || /\.(txt|cookies?)$/i.test(cf) || fs.existsSync(cf);
  const ytArgs = isFile ? ["--cookies", cf.replace(/^~(?=\/|$)/, os.homedir())] : ["--cookies-from-browser", cf];
  if (isFile && !fs.existsSync(cf.replace(/^~(?=\/|$)/, os.homedir())))
    fail(`cookies file missing: ${cf}`, `run: jukebox cookies   (then: jukebox host --cookies ${cf})`);
  else {
    const yt = Number(run("grep", ["-c", "youtube", cf.replace(/^~(?=\/|$)/, os.homedir())]).out ?? 0);
    yt > 0 ? ok(`${yt} YouTube cookies in ${cf}`) : fail(`no YouTube cookies in ${cf}`, `run: jukebox cookies`);
  }

  // 3. metadata lookup (search path)
  const meta = run("yt-dlp", [...ytArgs, "--no-playlist", "--skip-download", "--print", "%(title)s", "--", "https://youtu.be/dQw4w9WgXcQ"]);
  meta.err ? fail(`metadata lookup: ${meta.err}`, `run: jukebox cookies   then retry`) : ok(`metadata: ${meta.out.slice(0, 50)}`);

  // 4. bestaudio download = what jukebox plays (fallback to 18 like host does)
  const dl = (f) => {
    const tmp = path.join(os.tmpdir(), `jukebox-doctor.${Date.now()}.${f}`);
    const r = run("yt-dlp", [...ytArgs, "-f", f, "--no-playlist", "-o", tmp, "--", "https://youtu.be/dQw4w9WgXcQ"]);
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
    return r;
  };
  const a = dl("bestaudio");
  if (!a.err) ok("bestaudio download works");
  else if (/403|forbidden/i.test(a.err) && !dl("18").err) ok("bestaudio 403s but format 18 works (host auto-falls-back)");
  else fail(`audio download: ${a.err?.slice(0, 100)}`, `run: jukebox cookies   then retry`);

  // 5. audio output device (host plays through ffmpeg -> speakers)
  const sink = run("sh", ["-c", process.platform === "darwin" ? "system_profiler SPAudioDataType 2>/dev/null | grep -m1 'Output' || echo speaker" : "aplay -l 2>/dev/null | grep -m1 card || pactl get-default-sink 2>/dev/null || echo no-sink"]);
  /no-sink|not found|no such/i.test(sink.err ?? sink.out ?? "") ? fail("no audio output device", "plug in speakers or check PipeWire/ALSA") : ok(`audio device: ${(sink.out ?? "").slice(0, 50)}`);

  console.log(failed ? `\n${failed} check(s) FAILED — apply the fix lines above, then re-run: jukebox doctor` : "\nall checks passed — playback should work");
  process.exit(failed ? 1 : 0);
}

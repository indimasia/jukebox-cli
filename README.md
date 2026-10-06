# 🎶 Jukebox

A shared music queue that runs in your terminal. The host plays YouTube audio (audio only, no video) and shows a live full-screen view with a QR code. Guests scan the QR code to add songs from their phone, or join from their own terminal.

Inspired by [SongUp](https://github.com/motz0815/songup).

## Install

macOS or Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/indimasia/jukebox-cli/main/install.sh | bash
```

The script installs only what's missing:

- ffmpeg
- qrencode
- Node.js 18+
- yt-dlp
- cloudflared (for `--tunnel`)

On macOS it uses Homebrew. On Linux it uses apt, dnf or pacman, and installs the latest yt-dlp binary to `~/.local/bin`. The `jukebox` command goes in `~/.local/bin`.

## Host a room

```bash
jukebox host
jukebox host --tunnel      # guests can join from anywhere, not just your Wi-Fi
jukebox host --limit 3 --shuffle --fallback "https://www.youtube.com/playlist?list=..."
```

| Option | Default | What it does |
|---|---|---|
| `--port` | `7777` | Web/API port |
| `--limit` | `2` | Max songs each person can have waiting in the queue |
| `--shuffle` | off | Pick the next song at random instead of taking turns |
| `--tunnel` | off | Public HTTPS link via a free Cloudflare quick tunnel (no account), so guests on any network can join |
| `--stacked` | off | Start in the top/bottom layout (visualizer or QR on top, queue below) |
| `--fallback` | none | Playlist that plays when the queue is empty |

While hosting, type at the `>` prompt:

| Input | Action |
|---|---|
| song name or YouTube URL | add the top result |
| `s` | skip |
| `r` | toggle shuffle |
| `v` or `Tab` | switch between the QR code and the audio visualizer |
| `t` | switch layout: side by side, or top/bottom |
| `q` | quit |

## Join as a guest

- **Phone:** scan the QR code on the host screen. Type a name, search, and pick a song from the results. The page shows what's playing and the queue as cards, in the order they'll play.
- **Terminal:** `jukebox join <host-ip>:7777 <ROOM CODE> [name]`. Type a song, then pick a number from the results.

Without `--tunnel`, guests must be on the same network as the host. If phones can't connect, allow incoming connections for `node` in the host's firewall, or use `--tunnel`.

With `--tunnel`, terminal guests join with the full link: `jukebox join https://xxxx.trycloudflare.com <ROOM CODE> [name]`. The link is public, so the room code is the only thing keeping strangers out. The link changes every time you start a room.

## How it works

- Songs take turns fairly: whoever had a song played longest ago goes next.
- Guest songs always play before songs from the fallback playlist.
- No accounts. The room code is the only check.
- Audio goes `yt-dlp → ffmpeg → speakers`: CoreAudio on macOS, ALSA/PipeWire/PulseAudio on Linux.

## Uninstall

```bash
rm -rf ~/.local/share/jukebox ~/.local/bin/jukebox
```

## License

MIT

# Broadcast Controller

**Professional live‑production graphics for lower thirds, lyrics, media, timers and real‑time AI translation — all driven from one operator workspace.**

Broadcast Controller is a cross‑platform desktop app (macOS & Windows) that acts as the "brain" of a live service or event. From a single control window it drives audience‑facing **graphics output** windows (projector / LED / stream feed), a speaker **confidence monitor**, a **backstage** rundown, and an **NDI** feed for OBS / vMix — with GPU‑accelerated rendering for smooth, jitter‑free playback.

![Broadcast Controller — Run of Show](docs/screenshots/01-control-run-of-show.png)

---

## ✨ Features

- **Run of Show timeline** — build a sequential cue list (lyrics, lower thirds, media, timers, slides, blackout/clear) and fire cues in order.
- **Lyrics** — dual‑language (English + Gujarati) verse cueing with *Fast Take* and *Safe Arm* modes; search a song database or paste your own.
- **Lower Thirds** — styled name/title overlays with design presets, auto‑clear, and a per‑event queue.
- **Media** — video & photo playback with preview, seek, loop, volume, and playlists.
- **Pre‑Show countdown & timers** — branded countdowns mirrored to the audience and the confidence monitor.
- **Slides / Presentations** — drive presentation decks with next/previous preview.
- **Real‑time AI translation & captions** — Azure Speech, Soniox, or fully offline Local AI.
- **Confidence & Backstage monitors** — timers, speaker prompts, rundown, and private backstage messaging.
- **NDI output** — low‑latency network video (full graphics, or an individual layer) with preserved alpha for downstream keying.
- **Remote operators** — pair a tablet/phone/laptop over LAN to control layers from the floor.
- **GPU‑accelerated** — opaque, non‑throttled output windows use the hardware video fast path; particle overlays render on the GPU via WebGL2 in an OffscreenCanvas worker.
- **Collapsible icon sidebar**, command palette (`⌘K`), light/dark themes, and a built‑in Live Preview.

---

## 🚀 Installation

### Download a build (recommended for operators)
Grab the installer for your machine and run it:

| Platform | File |
|---|---|
| macOS — Apple Silicon (M‑series) | `Broadcast Controller-<version>-arm64.dmg` |
| macOS — Intel | `Broadcast Controller-<version>-x64.dmg` |
| Windows | `Broadcast Controller Setup <version>.exe` (installer) or `… Portable.exe` |

> macOS builds are unsigned, so the first launch needs **right‑click → Open** (or `xattr -dr com.apple.quarantine "/Applications/Broadcast Controller.app"`).

### Run from source (developers)
```bash
# 1. Install dependencies (root + frontend)
npm install
npm --prefix frontend install

# 2. Build the React frontend (served by the embedded server)
npm run build:frontend

# 3. Launch the Electron app
npm start
```

### Build installers
```bash
npm run build:mac     # produces arm64 + Intel .dmg in "application packages/"
npm run build:win     # run on Windows: nsis installer + portable .exe
```
Mac builds rebuild and validate the native NDI module per‑architecture automatically.

---

## 🧭 The Workspace

The interface has three regions:

1. **Top action bar** — master controls: **Command** palette (`⌘K`), **Graphics / Confidence / Backstage** window toggles, **Clear** (the "panic button" — fades all output instantly), theme toggle, and **Settings**.
2. **Collapsible left sidebar** — page navigation grouped by workflow (Control · Live · Graphics · Production Monitor). Click **Collapse** to shrink it to an icon‑only rail; the choice is remembered.
3. **Live Preview** (bottom) — a virtual monitor mirroring the active output; switch between Graphics, Stage, and Backstage views.

| Sidebar expanded | Sidebar collapsed |
|---|---|
| ![Sidebar expanded](docs/screenshots/01-control-run-of-show.png) | ![Sidebar collapsed](docs/screenshots/13-sidebar-collapsed.png) |

### What the audience sees
The graphics output renders over a green / black / transparent background (for chroma keying or alpha compositing):

| Lower third | Particle overlay |
|---|---|
| ![Lower third output](docs/screenshots/11-graphics-output-lower-third.png) | ![Particle overlay output](docs/screenshots/12-graphics-output-particles.png) |

---

## 📖 How to Use

### 1. Set up your displays
Open **Settings** (gear icon) → **Displays**, assign the connected screens to **Graphics**, **Confidence**, and **Backstage**, then click the matching buttons in the top bar to open each window on its screen. Testing on one screen? Open them locally and use the **Live Preview** to check your work.

![Settings](docs/screenshots/10-settings.png)

### 2. Build a Run of Show
On **Run of Show**, click **Add Cue**, pick a type (lyrics, lower third, media, timer, slide, clear/blackout), fill in its details, and drag to reorder. During the event, fire cues in order and check them off as you go. Operator notes stay private to the control panel.

### 3. Pre‑Show countdown
On **Pre‑Show**, pick a preset or custom duration, add a message (e.g. "Sabha Starts In"), style it, and **Take Live**. The countdown mirrors to the graphics screen and confidence monitor.

![Pre-Show](docs/screenshots/02-pre-show.png)

### 4. Slides & Media
**Slides** drives presentation decks with next/previous and a next‑slide preview. **Media** plays videos and photos with preview, seek, loop, volume, and playlists — select an item and **Take Live**.

| Slides | Media |
|---|---|
| ![Slides](docs/screenshots/03-slides.png) | ![Media](docs/screenshots/04-media.png) |

### 5. Lyrics
On **Lyrics**, search a song database or paste text, separate verses with blank lines, and choose English‑only / Gujarati‑only / both. Two cueing modes:
- **Fast Take** — clicking a verse sends it live instantly.
- **Safe Arm** — loads the verse into preview; press **Send Live (Go)** when ready.

Use **Spacebar** / **→** to advance verses without looking away from the stage.

![Lyrics](docs/screenshots/05-lyrics.png)

### 6. Lower Thirds
On **Lower Thirds**, enter the name and title (Gujarati supported), pick a design preset, optionally set an **Auto‑Clear** timer, and **Take Live**. Build a **queue** of name tags for multi‑speaker events.

![Lower Thirds](docs/screenshots/06-lower-thirds.png)

### 7. Real‑time translation
On **Translation**, choose an engine (**Azure Speech**, **Soniox**, or offline **Local AI**), set source/target languages, pick your audio input, and **Start Listening**. Watch the status indicator — green = listening, yellow = loading, red = error.

![Translation](docs/screenshots/07-translation.png)

### 8. Confidence & Backstage monitors
The **Confidence Monitor** shows the speaker timers, prompts, and what's next. The **Backstage Monitor** shows the rundown and private production messages (typed from the Backstage panel and never shown to the audience); it can also sync a Google Sheets rundown.

| Confidence Monitor | Backstage Monitor |
|---|---|
| ![Confidence Monitor](docs/screenshots/08-confidence-monitor.png) | ![Backstage Monitor](docs/screenshots/09-backstage-monitor.png) |

---

## 🔌 NDI, Remote & Output Modes

- **NDI output** — Settings → enable NDI, choose the source (full Graphics or a single layer). In OBS/vMix, add an **NDI Source** named `Broadcast Controller Graphics`. Alpha is preserved for clean keying.
- **Remote operators** — Settings → enable Remote Operators to get a pairing code + LAN URL; open it on a device on the same Wi‑Fi and enter the code for a mobile control surface.
- **Output background** — green (chroma key, default), black, or transparent. For a physical projector/HDMI keyer, green is standard; for software/NDI keying use transparent or black.

---

## ⌨️ Handy shortcuts

| Shortcut | Action |
|---|---|
| `⌘K` / `Ctrl+K` | Open the command palette |
| `Spacebar` / `→` | Advance to the next lyric verse / slide |
| **Clear** (top bar) | Instantly fade out all live output |

---

## 🛠️ Tech Stack

- **Electron 41** desktop shell (multi‑window output)
- **React + Vite** UI, **Tailwind CSS**, **GSAP** animations
- **Express + Socket.IO** embedded server (control ⇄ output ⇄ remote sync)
- **WebGL2 + OffscreenCanvas worker** particle renderer
- **NDI** via `@stagetimerio/grandiose`

### Project layout
```
main.js                  Electron main process (windows, GPU flags, NDI service)
server.js                Express + Socket.IO server (serves UI, syncs state)
ndi_output_service.js    Offscreen capture → NDI sender
frontend/src/            React control UI + graphics components
  ├─ App.jsx             Control window (sidebar nav, panels)
  ├─ GraphicsApp.jsx     Output windows (graphics / stage)
  └─ graphics/           Lower thirds, lyrics, media, particles (WebGL), etc.
public_react/            Built frontend served by the server
scripts/                 Build & native‑NDI rebuild helpers
docs/                    User guide + screenshots
```

---

## 📚 More

A full, operator‑focused walkthrough (with a pre‑show checklist and troubleshooting) lives in
[docs/Broadcast_Controller_User_Guide.md](docs/Broadcast_Controller_User_Guide.md).

---

*Built for live worship/event production with first‑class Gujarati support.*

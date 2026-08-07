# Broadcast Controller — Hardening, Performance & Cleanup Plan

> **STATUS: implemented.** P0–P4 have been applied to the working tree (uncommitted). Test suite
> is 230/230 green, frontend lint is 0 errors, `npm audit` is clean in both packages, and the app
> was launched and verified end-to-end. Two items were deliberately **not** done and are listed
> under "Deferred" at the end of this file, with reasons. Where implementation revealed the plan
> was wrong, the notes below say so.

---

## Context

Broadcast Controller is a live-production Electron app (Express + socket.io backend, React/Vite
multi-page frontend) that drives lower thirds, lyrics, presentation decks, NDI output and an ATEM
SuperSource during live services. Operators run it on a venue PC and control it from paired phones
and tablets over the venue LAN.

An audit of the whole codebase (`server.js` 3176 L, `main.js` 820 L, the three translation workers,
`atem_service.js`, `ndi_output_service.js`, ~18.7k lines of `frontend/src`, `tests/`, `scripts/`)
found the security model to be **well designed but with two breaks that undo it entirely**, plus a
set of hot-path broadcast storms that waste bandwidth and CPU during exactly the moments the app
must not stutter.

Two framing notes that matter for prioritisation:

- **The good parts are genuinely good and must not be regressed.** Per-launch random auth token,
  network-interface confinement, timing-safe comparisons, pairing-code rotation with brute-force
  lockout, `contextIsolation: true` / `nodeIntegration: false` on every window, a real
  integration test suite that drives the actual server over real sockets, and unusually good
  *why*-not-*what* comments. Preserve all of it.
- **Known non-goal:** video jitter on this rig traces to the DisplayLink dock, not the app. Do not
  chase it here.

The intended outcome: close the auth break, stop the process from being remotely crashable, cut the
per-frame socket fan-out, stop a single component throw from blanking the on-air window, put the
operator's song and deck libraries somewhere they cannot silently vanish, and leave `server.js` and
`App.jsx` in a shape where the next feature does not have to be added to a 3000-line file.

Three findings were verified by running them, not just by reading: the `timingSafeEqual` byte-length
throw, the fact that a throwing socket.io middleware surfaces as an uncaught process-level exception,
and the two sets of leaked socket listeners. Those are not theoretical.

---

## How to work in this repo

```bash
npm --prefix frontend install && npm install
```

```bash
npm test
```

- `npm test` runs `node --test tests/*.test.js` (**needs Node ≥ 22** — the glob does not expand on
  18). It imports `socket.io-client` from `frontend/node_modules`, so the frontend install is a
  hard prerequisite, not a convenience.
- `tests/server-socket.test.js` starts the **real** `server.js` on an ephemeral port with
  `BROADCAST_CONTROLLER_AUTOSTART=0` and redirects persistence to a temp dir via
  `setTranslationGlossaryDir`. Add backend regression tests there; the seams you need
  (`resetServerStateForTests`, `setTranslationWorkerFactoryForTests`, `expireRemoteSessionForTests`)
  are already exported at [server.js:3145-3176](server.js).
- **Ack-shape gotcha:** the test helper `emitWithAck(socket, event, payload)` assumes a
  `(payload, ack)` handler. Against a single-param `(ack)` handler the promise never settles and the
  test hangs with no diagnostic. Keep every new handler `(payload, ack)`. Fixing `emitWithAck` to
  race a 1s timeout is item **P3.1** below and is worth doing first if you will be writing many tests.
- Frontend lint is `npm --prefix frontend run lint`. It is now **0 errors / 6 warnings**; treat any
  new error as a regression. (It was 3 errors / 16 warnings before P2.7.)
- **Anything under `frontend/src/graphics/` renders on air.** A mistake there is dead air, not a bug
  report. Do P1.0 (error boundaries) before refactoring any of it, and smoke-test each graphics change
  in the real app rather than trusting tests — there are none for these components.
- Run `npm run build:frontend` before `npm start`; the built bundles land in `public_react/` and are
  what the server actually serves.

---

## P0 — Security. Fix these first, one commit each.

### P0.1 — Paired remote devices can steal the desktop auth token (full privilege escalation)

**This is the most serious finding in the codebase.** The entire local-vs-remote privilege split is
bypassed by one navigation.

`requireAuth` accepts *either* token type ([server.js:211-216](server.js)):

```js
function requireAuth(req, res, next) {
    if (isValidAuthToken(getRequestToken(req)) || isValidRemoteToken(getRequestRemoteToken(req))) {
        return next();
    }
    return res.status(403).send('Forbidden');
}
```

But the six desktop HTML routes — `/`, `/index.html`, `/graphics`, `/graphics.html`, `/backstage`,
`/backstage.html` ([server.js:987-1009](server.js)) — are all gated with `requireAuth` and served by
`sendAppHtml`, which **embeds the local token in the page and sets it as a cookie**
([server.js:267-272](server.js)):

```js
res.send(html.replace('</head>',
    `<script>window.__BC_AUTH_TOKEN__=${JSON.stringify(AUTH_TOKEN)};</script></head>`));
```

So a device that paired via `/api/remote/pair` (holding only `bc_remote_token`) can navigate to
`http://<lan-ip>:<port>/`, receive HTTP 200, and read the desktop token out of the page. With it,
the remote can:

- connect socket.io as `clientType: 'local'` ([server.js:2135-2137](server.js)), defeating every
  `onLocalSocket` gate;
- read **any** video/image file on the operator's disk via `?path=`
  ([server.js:504-513](server.js) — see P0.3);
- drive the ATEM, change the remote-access network, disable remote access, revoke other sessions,
  and write `atem-settings.json` / `local-ai-settings.json` to disk.

**Fix:** switch those six routes to `requireLocalAuth`, which already exists and is correct
([server.js:218-223](server.js)). Remotes are served by `sendRemoteHtml`
([server.js:274-278](server.js)), which correctly does *not* embed the token — that path is
unaffected. Audit every other `requireAuth` call site while you are here and downgrade any that
serves or implies local capability; `requireAuth` should remain only where a remote genuinely needs
access (`/local-video`, `/local-image` by `mediaId`).

**Regression test** (in `tests/server-socket.test.js`, near the existing remote-capability tests):
pair a remote, then assert `GET /` with only the remote cookie returns 403, and that the response
body of every remote-reachable route never contains `__BC_AUTH_TOKEN__`.

---

### P0.2 — Any client on the LAN can crash the Electron main process with one handshake

`isValidAuthToken` compares **UTF-16 code-unit length** but builds **UTF-8 byte buffers**
([server.js:115-117](server.js)):

```js
return typeof token === 'string' && token.length === AUTH_TOKEN.length
    && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(AUTH_TOKEN));
```

A 64-character multi-byte string passes the length check and yields a 128-byte buffer.
**Verified by running it:** `crypto.timingSafeEqual` throws
`RangeError: Input buffers must have the same byte length`.

Over HTTP that is a contained 500. Over socket.io it is fatal: `isValidAuthToken` is called inside
the `io.use` middleware at [server.js:2135](server.js), and socket.io's middleware runner has no
try/catch. **Verified by running a minimal reproduction**: a throwing `io.use` middleware surfaces
as an `uncaughtException` at process level. There is **no `process.on('uncaughtException')` or
`unhandledRejection` handler anywhere in this codebase**, so the Electron main process dies —
mid-broadcast. Reachable from loopback always, and from the venue LAN whenever Remote Operators is on.

**Fix, three parts:**

1. Compare `Buffer.byteLength(token) === Buffer.byteLength(AUTH_TOKEN)` before the
   `timingSafeEqual`, or wrap the call in try/catch returning `false`. Apply the identical fix to
   `timingSafeEqualString` ([server.js:134-138](server.js)) — it has the same shape and is safe today
   only because its single caller pre-strips non-digits at [server.js:1060](server.js). Do not leave
   that as an implicit invariant.
2. Wrap the whole `io.use` body in try/catch → `next(new Error('Unauthorized'))`, so no future
   throw in that middleware can ever take the process down.
3. Add `process.on('uncaughtException')` and `process.on('unhandledRejection')` handlers in
   `main.js` that log with full stack to the userData dir and keep the app alive. For a live-show
   tool, dying silently on one rejected promise is the wrong default.

**Regression test:** connect a socket with `auth: { token: 'é'.repeat(64) }` and assert the server
rejects the connection and is still accepting connections afterwards.

---

### P0.3 — `?path=` is an unrestricted arbitrary-file-read for any local-token holder

`resolveMediaRequest` falls back to a raw caller-supplied path when the registered-media lookup
misses ([server.js:504-513](server.js)):

```js
if (isValidAuthToken(getRequestToken(req))) {
    return getValidatedLocalPath(req.query.path, allowedExtensions);
}
```

`getValidatedLocalPath` ([server.js:445-462](server.js)) checks only NUL bytes, extension
allow-list and `isFile` — there is **no directory confinement**. Any `.mp4/.mov/.webm/.mkv/
.jpg/.jpeg/.png/.webp/.gif/.bmp` anywhere on the machine is readable. On its own that is
local-only; chained with P0.1 it became remotely reachable, which is why it is P0.

The `mediaId` registry ([server.js:464-489](server.js)) already exists, is well built
(`realpathSync`, extension allow-list, opaque random ids) and is what the frontend uses via
`POST /api/local-media/register`.

**Fix:** delete the `?path=` fallback entirely and require `mediaId` on `/local-video` and
`/local-image`. Grep the frontend for `path=` query construction first and convert any remaining
caller to register-then-use. If a fallback must survive for a transition period, confine it to
directories the operator has explicitly picked in this session rather than the whole filesystem.

**While in this code:** `registeredLocalMedia` ([server.js:76](server.js), written at
[server.js:487](server.js)) is **never evicted** — every registered path is a permanent capability
for the process lifetime and an unbounded Map. Add a TTL sweep or an LRU cap, mirroring the FIFO
eviction already used correctly for `presSlideBufferCache` at [server.js:1545-1551](server.js).

---

### P0.4 — `pres_update` is unvalidated, uncapped, and not local-gated

```js
socket.on('pres_update', (data) => {   // server.js:2697-2701
    currentPresState = data;
    bumpPresDeckId();
    broadcastPresState();
});
```

The client payload is stored **verbatim** — no schema, no size cap, no local gate — bounded only by
`maxHttpBufferSize: 1e8` (**100 MB**, [server.js:20](server.js)). Any paired remote can pin 100 MB of
server memory and force a fan-out of it to every local socket via `broadcastPresState`
([server.js:1910-1915](server.js)). The remote-facing path is correctly stripped by
`getPresStateLite` ([server.js:1895-1901](server.js)); the local path ships the entire base64
`images` array to graphics/stage/NDI over the socket.

**Fix:** wrap with `onLocalSocket`, add a `normalizePresState(data)` validator (mirroring the
existing `normalizeAtemSettings` / `normalizeLocalAiSettings` / `normalizeMediaMessageOverlay`
pattern) that enforces shape, slide count and total byte budget, and reject oversized payloads with
an ack error rather than storing them. Lower `maxHttpBufferSize` to a realistic ceiling once decks
no longer travel as base64 (see P2.2).

**Same pattern, smaller blast radius** — apply the same normalize-and-gate treatment to the other
raw relays: `backstage_state_update` ([server.js:2562-2581](server.js), 500 rows of arbitrary
content), `set_stage_timer`, `set_stage_message`, and the `update_*_style` / `update_*_layout`
handlers.

---

### P0.5 — Electron hardening

Three separate items, all in `main.js`:

1. **`sandbox: false` on every window** ([main.js:226](main.js), `:288`, `:341`, `:391`,
   [ndi_output_service.js:113](ndi_output_service.js)). `preload.cjs` is 22 lines exposing only
   argument-free `dialog.showOpenDialog` invocations plus two event subscriptions — **nothing in it
   requires `sandbox: false`**. These windows embed operator-chosen third-party websites in iframes,
   which is exactly the case the renderer sandbox exists for. Set `sandbox: true` and verify the
   four file-picker IPC paths and NDI capture still work.
2. **`shell.openExternal` is reachable from embedded untrusted content**
   ([main.js:96-101](main.js)). `setWindowOpenHandler` fires for `window.open()` from *any* frame,
   including a third-party page embedded in the graphics output, and hands the URL straight to
   `shell.openExternal`. It is restricted to `http:`/`https:` so there is no protocol-handler
   command execution, but an embedded page can still pop the operator's browser mid-show. Gate on
   the requesting frame being an app origin, or drop to `action: 'deny'` for subframes.
   (`will-navigate` at [main.js:103-110](main.js) already correctly pins top-level navigation — leave
   it alone.)
3. **Frame-protection headers are stripped process-wide**
   ([main.js:546-572](main.js)): `x-frame-options`, COEP, COOP, CORP and CSP `frame-ancestors` are
   removed from *all* subframe responses in `session.defaultSession`. This is deliberate (it is what
   lets arbitrary sites be embedded in graphics output) but it currently applies to every site the
   operator ever loads. Scope the rewrite to the specific graphics/stage windows via a partitioned
   session rather than `defaultSession`, so a compromised embed cannot ride it elsewhere.

---

### P0.6 — Smaller security fixes (bundle into one commit)

| Issue | Location | Fix |
|---|---|---|
| `/search-anirdesh` builds a POST body with only `q` encoded — `what`, `type`, `beg` are interpolated raw, allowing extra fields to be injected upstream | [server.js:1203-1213](server.js) | `encodeURIComponent` all four |
| `/fetch-anirdesh` reflects third-party HTML as `text/html` **on the app's own origin**, which holds `__BC_AUTH_TOKEN__` — stored XSS if upstream is ever hostile | [server.js:1191-1194](server.js) | serve as `text/plain`, or sanitize and parse server-side |
| `remote_pairing_code_rotate` assigns `remotePairingCode` directly instead of calling `rotatePairingCode()`, so a graced code from a preceding *timed* rotation stays valid after a **manual** rotate — the exact thing manual rotation exists to prevent. It also never updates `remotePairingCodeIssuedAt`, so the countdown shown to the operator is wrong | [server.js:2249-2253](server.js) | call `rotatePairingCode({ grace: false })` |
| Translation API keys (Azure/Soniox) cross the LAN in cleartext because `start_translation` is local-gated only for the `local` engine | [server.js:2788-2789](server.js) | gate all three engines with `onLocalSocket` |
| ATEM push payloads unvalidated; `patch.boxIndex` checked against an upper bound only, so a negative index passes | [main.js:702](main.js), [atem_service.js:428](atem_service.js) | validate range and `props` shape |
| `express.json()` is registered at [server.js:22](server.js), **before** the interface-confinement middleware at `:981`, so bodies from blocked networks are still parsed | [server.js:22](server.js) | move the confinement middleware above the body parser |
| `remote.html` / `pad.html` are reachable both as routes (with `__BC_REMOTE_ENTRY__` injected) and directly through `express.static` (**without** it), yielding a subtly different app | [server.js:1018-1028](server.js), `:1115` | exclude those filenames from the static handler |

---

### P0.7 — Frontend: remote code execution surface and plaintext credentials

**`pdf.js` is loaded from a CDN with no integrity check, into an Electron renderer**
([PresentationPanel.jsx:338-342](frontend/src/components/PresentationPanel.jsx)):

```js
if (!window.pdfjsLib) {
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}
```

`loadScript` ([PresentationPanel.jsx:264-276](frontend/src/components/PresentationPanel.jsx)) appends
a `<script>` with **no `integrity` and no `crossorigin`**. A compromised or MITM'd CDN gets arbitrary
code execution in a renderer that (until P0.5) is unsandboxed. It is also an **availability bug**:
PDF import silently fails on a venue rig with no internet, which is the normal state for an isolated
broadcast LAN.

**Fix:** add `pdfjs-dist` as an npm dependency and switch to a lazy `import()`. This removes the
supply-chain risk and the offline failure in one change.

**Two more CDN dependencies on the on-air output window** ([graphics.html:7-10](frontend/graphics.html)):
`https://www.youtube.com/iframe_api` loaded synchronously in `<head>` (stalls the on-air renderer's
parse if slow or blocked — and `MediaGraphic.jsx:256-265` *also* injects it conditionally, so it is
loaded twice over), and an 11-family Google Fonts stylesheet. That fonts link **directly contradicts**
the policy stated at [index.css:5-8](frontend/src/index.css) — *"Nothing here is fetched from a CDN,
so Gujarati renders with no internet."* The Gujarati faces are correctly self-hosted from `/fonts`;
the Latin display faces are not, so if Google Fonts is unreachable at showtime, lower thirds and
lyrics silently fall back to a system font mid-service. Self-host these the same way the Gujarati
fonts already are, and load the YouTube API lazily from `MediaGraphic` only.

**Plaintext API keys in `localStorage`, rewritten on every keystroke**
([TranslationPanel.jsx:6-8, 39-41, 111-125](frontend/src/components/TranslationPanel.jsx)):

```js
useEffect(() => { localStorage.setItem(AZURE_KEY_STORAGE, azureKey); }, [azureKey]);
useEffect(() => { localStorage.setItem(SONIOX_KEY_STORAGE, sonioxKey); }, [sonioxKey]);
```

Paid third-party credentials sit unencrypted in the renderer and are shipped over the socket at
`:582`. The `type="password"` masking at `:952`/`:1000` is cosmetic. **Fix:** store them via Electron
`safeStorage` in the main process (new IPC channels in `preload.cjs`), and keep them out of the
renderer entirely — the server already forwards them to the worker, so the renderer only needs to
know *whether* a key is set, not its value. This also fixes the fact that "Clear Cache"
([App.jsx:672-677](frontend/src/App.jsx)) silently wipes the operator's Azure subscription key.

**One thing that is already correct and must stay that way:** there is **zero**
`dangerouslySetInnerHTML`, `innerHTML`, `eval` or `new Function` anywhere in `frontend/src`
(verified). All operator and remote content — lyrics, lower-third names, captions, backstage
messages — goes through JSX text interpolation. Do not introduce HTML injection when refactoring the
graphics components.

**Also worth confirming rather than fixing:** `isRemoteEntry()`
([auth.js:9-11](frontend/src/auth.js)) is `Boolean(window.__BC_REMOTE_ENTRY__) || pathname === '/remote'`
— **fully spoofable from devtools**. It drives `isRemoteClient` ([App.jsx:250](frontend/src/App.jsx)),
which hides the Device Controls and Remote Pad tabs and the Factory Reset button. This is UI-only
gating, and that is *acceptable* provided the server is the real authority. `onLocalSocket` exists and
`action_forbidden` is handled at `RemotePadApp.jsx:186`, so the design is right — but as part of P0.1,
enumerate every emit reachable from a `localOnly` tab and assert each is `onLocalSocket`-gated
server-side. Any that is not is a real privilege hole hidden behind a spoofable boolean.

---

## P1 — Live-path reliability and performance

### P1.0 — There are no error boundaries anywhere, so one throw blanks the on-air window

**This is the most consequential reliability gap in the frontend.** Verified: zero matches for
`ErrorBoundary` / `componentDidCatch` / `getDerivedStateFromError` across all of `frontend/src`. All
five entry points mount bare:

```jsx
// graphics-main.jsx:6-10 — identical in main/remote/pad/backstage-main.jsx
createRoot(document.getElementById('root')).render(
  <StrictMode><GraphicsApp /></StrictMode>
)
```

A throw inside any single graphic — malformed `cinematicGrad` data hitting `parseFloat` at
`LyricsGraphic.jsx:229-231`, a bad YouTube payload in `MediaGraphic` — unmounts the **entire graphics
output window** and puts a blank frame on air.

**Fix:** add an `ErrorBoundary` component and wrap **each layer individually** in
[GraphicsApp.jsx:128-135](frontend/src/GraphicsApp.jsx), so a failed layer degrades to
nothing-rendered instead of taking down the whole output. Wrap the four other entry roots too, and
have the boundary report the error over the socket so the operator sees *which* layer died rather
than just a black frame.

### P1.1 — NDI status is broadcast to every client 30 times per second

Inside `sendFrame()`, which runs on the frame timer ([ndi_output_service.js:265-270](ndi_output_service.js)):

```js
this.frameCount += 1;
this.emitStatus({ enabled: true, lastFrameAt: Date.now(), error: null });
```

`emitStatus` → `onStatus` → `io.emit('ndi_status_update', status)` ([main.js:509](main.js)). At 30 fps
that is **30 full-state broadcasts per second to every connected client** — control window, graphics,
stage, backstage, the NDI renderer itself, *and every paired phone over Wi-Fi*.

A dedicated 1 Hz `statusTimer` → `pollStatus` already exists at
[ndi_output_service.js:186](ndi_output_service.js) for exactly this purpose.

**Fix:** in `sendFrame`, only bump `frameCount` and store `lastFrameAt` on `this`. Let `pollStatus`
publish at 1 Hz. Keep the error-path `emitStatus` at `:272` immediate.

### P1.2 — ATEM full status is broadcast 25× per second during a SuperSource drag

`flush()` emits on every successful batch ([atem_service.js:464-468](atem_service.js)) and runs at
`FLUSH_INTERVAL_MS = 40`. Each emit ships the **entire** status object — `getStatus()`
([atem_service.js:99-113](atem_service.js)) deep-copies `inputs`, `auxSources`, all `mixEffects` with
nested `upstreamKeyers`, `downstreamKeyers`, `auxiliaries`, `auxBusNames` — and
[main.js:515-519](main.js) then iterates **every socket individually**, calling `getPublicStatus()`
per remote socket.

The `stateChanged` path is already correctly throttled to 250 ms at
[atem_service.js:224-235](atem_service.js). **Fix:** route the push path through the same throttle,
and compute `getPublicStatus()` once per flush instead of once per remote socket.

### P1.3 — `emitOperatorState()` fires on nearly every event, with no diffing or debounce

31 call sites in `server.js`. Each builds the full operator snapshot
(`getOperatorState`, [server.js:1813-1862](server.js)) and `io.emit`s it to all clients. Because most
handlers *also* `io.emit` the specific change, a typical state mutation produces **two full
broadcasts**.

The worst path: `translation_update` ([server.js:2840](server.js)) does `io.emit` +
`emitOperatorState()` **for every interim ASR token** — the highest-frequency event in the app during
live translation.

**Fix:** debounce `emitOperatorState` on a ~100 ms trailing edge (coalescing bursts into one emit),
and drop it entirely from the `translation_update` path — the dedicated `translation_update` event
already carries what changed. If any consumer depends on operator-state freshness there, have it
listen to the specific event instead.

### P1.4 — NDI frame path allocates ~240 MB/s of garbage

Every `paint` allocates a fresh `toBitmap()` buffer — ~8 MB at 1080p BGRA
([ndi_output_service.js:152-156](ndi_output_service.js)). On HiDPI it additionally runs a full CPU
`image.resize()` **per frame** ([ndi_output_service.js:149-151](ndi_output_service.js)), rescaling a
4K surface 30 times a second.

**Fix:** set the offscreen surface's scale factor once at window creation so `paint` delivers frames
at the target resolution natively, removing the per-frame resize. Reuse a single buffer across paints
if `grandiose`'s `sender.video()` copies synchronously — **verify that before reusing**, because
`sendFrame` already re-sends `this.latestFrame` repeatedly with no copy and an async retain would be
a real corruption bug.

**Architecture note:** the overall design here is good — `paint`-driven capture rather than
`capturePage()` polling, `setFrameRate` capping, an `isSendingFrame` reentrancy guard and a monotonic
`sessionId` guarding every async continuation. Do not restructure it; just remove the allocations.

### P1.5 — Small wins

- **`set_bg_color` is registered twice** — [server.js:2644](server.js) *and*
  [main.js:637](main.js), both doing `io.emit('bg_color_update', color)`. Every colour change is
  broadcast twice. Delete one.
- **`broadcastDisplays()` on every connection** ([main.js:591-593](main.js)) `io.emit`s to *all*
  clients rather than the connecting socket — O(n²) fan-out at startup when five windows connect at
  once. Change to `socket.emit`.
- **Per-request `readFileSync`** in `sendAppHtml` / `sendRemoteHtml`
  ([server.js:268](server.js), `:275`) — cache the HTML at startup. This also removes an unguarded
  sync throw (see P2.3).
- **`console.log('Sabha Timer State Merged:', currentSabhaState)`**
  ([server.js:2590](server.js)) logs a full object on every client timer tick. Remove or gate behind
  a debug flag.

### P1.6 — Socket listeners are torn down and re-attached on every render

**`graphics/LyricsGraphic.jsx:148`** — `contextSafe(fn)` is invoked *during render*, so `animateIn`
(`:42`) and `animateOut` (`:98`) get fresh identities every render, and they are effect dependencies:

```js
}, [socket, animateIn, animateOut]);
```

All five listeners (`play_lyrics`, `stop_graphic`, `stop_lyrics`, `update_lyrics_style`,
`update_lyrics_layout`) are removed and re-added on every render. Each verse change causes
`setData` + `setStyle` + `setFitScale` → 2-3 renders → 15 `off`/`on` pairs.

**`graphics/TranslationGraphic.jsx:162`** is the same bug and much hotter:

```js
}, [socket, windowMode, style, autoClear, triggerAnimateOut]);
```

`style` is an object set from **every incoming caption** (`:90`), and `triggerAnimateOut` (`:53`) is
another unmemoized `contextSafe` closure. During live captioning this fires several times per second,
and **a `translation_update` arriving mid-teardown is dropped** — a dropped caption on air.

**The correct pattern is already in this codebase.**
[LowerThirdsGraphic.jsx:75-76](frontend/src/graphics/LowerThirdsGraphic.jsx) stashes
`animateInRef`/`animateOutRef` and memoizes `stopActiveAnimation` (`:93`) and `finishClear` (`:105`)
with `useCallback`, giving stable deps at `:260`. Port that pattern to Lyrics and Translation.

### P1.7 — Leaked socket listeners (verified)

**`MediaPanel.jsx`** registers `photo_stop` at `:188` but the cleanup at `:201-210` removes seven
other events and **not** `photo_stop`. Under React 19 StrictMode ([main.jsx:7](frontend/src/main.jsx))
the effect double-fires in dev, so the handler is permanently duplicated; on any real remount it
accumulates.

**`MediaGraphic.jsx`** registers `media_set_loop`, `media_set_auto_next` and `media_set_muted` at
`:195-197`, and the cleanup at `:238-247` removes **none of the three**.

Compounding both: the cleanups use the argument-less `socket.off('media_play')` form, which removes
*every* listener for that event on a socket that is shared at module scope
([GraphicsApp.jsx:15](frontend/src/GraphicsApp.jsx)). **Fix:** always `off(event, handler)` with the
same reference, and add the three missing removals.

**While in `MediaPanel`:** delete the `document.dispatchEvent(new CustomEvent('bc_media_trigger_next'))`
workaround at `:194-197` / `:228-234`. It bounces a socket event through a synthetic DOM event to dodge
a stale closure, its comment describes a functional state update that does not exist, and the listener
effect re-subscribes on every `playlist` change. A `useRef` mirror — already used correctly at
`MediaPanel.jsx:546-547` and `RemotePadApp.jsx:240-243` — removes it entirely.

### P1.8 — `PadButton`'s memoization is defeated at the call site

[PadButton.jsx:129](frontend/src/components/PadButton.jsx) is memoized with an explicit rationale, and
[RemotePadApp.jsx:238-239](frontend/src/RemotePadApp.jsx) goes to real trouble with live refs to keep
`fire` stable. Then the call site throws it away:

```jsx
onFire={() => fire(button)}   // RemotePadApp.jsx:362 — new arrow every render
```

`mediaTime` streams continuously from a socket event (`:185`), so **every playhead tick repaints every
pad key on the tablet** — precisely what the memo was written to prevent. **Fix:** pass
`onFire={fire}` and have `PadButton` call `onFire(button)`.

### P1.9 — 100 ms intervals driving React state

[StageDisplayPanel.jsx:92-118](frontend/src/components/StageDisplayPanel.jsx) and
[StageDisplayGraphic.jsx:130](frontend/src/graphics/StageDisplayGraphic.jsx) each run a 100 ms interval
setting `progressPct` / `progressColor` / `timerText` — **10 re-renders per second** of a 456-line,
22-state panel and of the confidence-monitor output, for purely presentational values. Drive the bar
with a CSS transition or a ref-driven style write instead of state.

Also: `MediaPanel.jsx:549-572`'s 1 s scheduled-plays interval is never torn down when there are no
schedules; and `BackstageApp.jsx:34` / `BackstageCueSheetPanel.jsx:35` re-render the whole rundown
twice a second via `setNow(Date.now())`.

### P1.10 — All 12 panels stay mounted, and none are memoized

[App.jsx:1443-1469](frontend/src/App.jsx) renders every panel simultaneously and hides inactive ones
with `display: none`. This is deliberate for state retention (there is a comment defending it at
`:1440-1441` for the pad case), but the cost is that MediaPanel's 54 state slots, TranslationPanel's
39 and LyricsPanel's 38 are **live and re-rendering at all times** — a 5 Hz `media_time_update`
re-renders a hidden 1654-line component. **Zero panels are wrapped in `React.memo`** (only
`PadButton` is).

**Fix, cheapest first:** wrap every panel in `React.memo`; then lift panel state into a context/store
so the *view* can unmount while state persists. Also delete
`const [socketConnected, setSocketConnected] = useState(false)`
([App.jsx:307](frontend/src/App.jsx)) — the value is **never read**, but every connect/disconnect
triggers a full re-render of the 1502-line App.

### P1.11 — Bundle size, and the 2.5-second delay hiding it

The control window parses **~630 KB of JS before first paint**: `main-*.js` is 394 KB with **no code
splitting**, plus a 233 KB shared chunk. Nothing can be lazily loaded because
[App.jsx:7-19](frontend/src/App.jsx) statically imports all 13 panels and `:1443-1469` mounts them all
— so `SuperSourcePanel` (854 + 505 lines of model) and `TranslationPanel` (1486 lines, ~400 of them
help modals) ship in the initial payload even in sessions that never open those tabs.

This is almost certainly what [App.jsx:169-173](frontend/src/App.jsx) is compensating for:

```js
// Defer iframe loading to speed up initial app startup
useEffect(() => { const timer = setTimeout(() => setIframesReady(true), 2500); ... }, []);
```

A hardcoded 2.5 s delay before the operator's live preview appears is a workaround for a bundle
problem. **Fix:** `React.lazy` + `Suspense` on the four or five heaviest panels, then reduce or remove
that timeout.

Separately, the **110 KB CSS bundle ships to every page** because all five `*-main.jsx` files import
`index.css` — the graphics output window, the phone slides remote and the iPad pad all download the
complete Tailwind build including control-surface classes they never use. On congested venue Wi-Fi
that is real first-load latency on the remotes. Split into shared tokens + per-surface sheets.

`vite.config.js` itself is correct and minimal; the gaps are **no `build.sourcemap`** (production
sourcemaps, even `'hidden'`, would make renderer-crash triage possible for an app where a crash means
dead air) and no `build.target` pin.

### P1.12 — Blocking modals on a live machine

35 uses of `window.alert` / `window.confirm` (e.g. `App.jsx:697`, `:705`, `:713`, `:720`;
`MediaPanel.jsx:349-350`). These block the Electron renderer's event loop — on a broadcast machine a
modal freezes graphics rendering until someone dismisses it. Replace with non-blocking in-app toasts
and dialogs.

---

## P2 — Correctness, data safety, and structure

### P2.1 — Per-socket `autoClearTimer` causes phantom hides and cross-client desync

`autoClearTimer` is a **per-socket closure** ([server.js:2302](server.js)). The `disconnect` handler
([server.js:3023-3025](server.js)) only logs — it never clears a pending timer. Two consequences:

- A pending auto-clear fires after the operator's browser is gone, calling `triggerHide()` →
  `io.emit('stop_graphic')` and **blanking live output**.
- `hide_lower_third` from socket B cannot cancel socket A's timer, so a graphic shown from the
  desktop and hidden from a tablet still gets a phantom hide later.

**Fix:** move `autoClearTimer` to module scope alongside the other authoritative `currentX` state so
there is exactly one timer for the one live graphic, and clear it in the `disconnect` handler.
Add it to `resetServerStateForTests`. Regression test: show from client A, hide from client B, assert
no `stop_graphic` arrives after the auto-clear interval.

### P2.2 — The operator's song and deck libraries can vanish silently

**This is the highest-risk *data* finding, and the one an operator would actually notice.**

Image decks store full base64 slide images in `localStorage`
([PresentationPanel.jsx:145-146](frontend/src/components/PresentationPanel.jsx)). Chromium's
per-origin quota is ~5 MB; a 30-slide 1920×1080 PDF blows past it immediately. The write path
swallows the error ([frontend/src/utils/performance.js:102-108](frontend/src/utils/performance.js)):

```js
try { localStorage.setItem(key, JSON.stringify(value)); }
catch (error) { console.error(`Failed to persist ${key}:`, error); }
```

The operator builds a deck, sees it in the library, restarts, and it is gone — with no UI signal,
only a devtools console line.

Compounding it: `handleClearCache` ([App.jsx:672-677](frontend/src/App.jsx)) calls
`localStorage.clear()` behind a single `window.confirm`, wiping the song library, deck library,
message presets, API keys and display assignments — and the confirm text does not mention the last
two. There is **no export or backup path anywhere**.

**Fix, in order:**

1. Move deck images out of `localStorage` into IndexedDB (or, better for a desktop app, files under
   Electron's userData dir addressed by id). Keep only metadata in `localStorage`.
2. Make quota failure **visible** — surface a toast/banner rather than a console line.
   `PresentationPanel.jsx:70` already has a `persistLibrarySafe` that returns `false`; check whether
   callers act on it and make them.
3. Add **Export / Import library** (JSON download + file picker). This is the single highest-value
   *feature* improvement in this plan: it is the only thing standing between the operator and
   unrecoverable loss, and it also gives them a way to move a library between the dev machine and the
   venue PC.
4. Narrow `handleClearCache` to named keys and list exactly what will be lost.

### P2.3 — Error handling gaps

- **No `unhandledRejection` / `uncaughtException` handlers anywhere** — covered in P0.2 part 3.
- **Floating promises in `main.js`:** `controlWindow.loadURL(...)` at [main.js:236](main.js) and the
  same pattern at `:297`, `:349`, `:400` — no `.catch()`. A failed load becomes an unhandled
  rejection.
- **`atem_connect`** ([main.js:667-679](main.js)) calls `saveAtemSettings`
  ([server.js:719-725](server.js)), which does `mkdirSync`/`writeFileSync` with no try/catch, from an
  `async` handler with no try/catch. A read-only userData dir yields an unhandled rejection. Note
  [server.js:2964-2977](server.js) wraps the *same* call correctly — match it.
- **`sendAppHtml` / `sendRemoteHtml`** `readFileSync` unguarded — a missing `public_react/` build
  produces a 500 with a stack trace instead of "run `npm run build:frontend`". Fixed for free by the
  startup-cache change in P1.5.
- **No Express error-handling middleware and no 404 handler** in `server.js`. Add both.
- **`atem_service.js:357`** — `rebuild()` calls `this.connect(...)` with no `await`/`.catch()`; safe
  only because `connect` happens to catch internally. Make it explicit.
- **`translation_worker.js:144`** — `activePushStream.write(buf)` is unguarded inside the IPC
  `message` handler; a write to a closed stream throws and takes down the worker.

### P2.4 — Settings writes are non-atomic

All four settings files use bare `fs.writeFileSync` ([server.js:344](server.js), `:604`, `:722`,
`:824`). A crash mid-write truncates the file. The loaders all fall back to defaults on parse
failure — which is the *right* pattern and should be kept — but it means truncation presents as
**silent config loss**, and `atem-settings.json` holds the switcher address at showtime.

**Fix:** one shared `writeJsonAtomic(filePath, value)` helper (write temp + `renameSync`) used by all
four save functions. While there, add a `version` field to all four and read it — only the glossary
writes one today ([server.js:826](server.js)) and even that is never read, with the loader instead
sniffing shape at `:812`. There is no migration hook anywhere; add the seam before you need it.

### P2.5 — `server.js` is a 3176-line monolith

Eight unrelated concerns in one module, with ~40 module-level mutable `currentX` globals
([server.js:1575-1665](server.js)) and an **830-line** `io.on('connection')` handler
([server.js:2197-3026](server.js)) holding 62 `socket.on` registrations.

**Do this incrementally — extract modules one at a time, running `npm test` after each.** Suggested
split, easiest and most self-contained first:

| New module | Extracts | Current lines |
|---|---|---|
| `lib/settings-store.js` | the four near-identical normalize/load/save/validate blocks + the atomic-write helper from P2.4 | `:316-349`, `:564-644`, `:646-755`, `:773-831` |
| `lib/scrapers.js` | Google Sheets, Anirdesh, YouTube InnerTube proxies (~240 lines of scraping in the YouTube one alone) | `:896-936`, `:1167-1252`, `:1254-1494` |
| `lib/local-media.js` | media registry + HTTP range streaming | `:445-532`, `:938-976`, `:1128-1140` |
| `lib/auth.js` | token/session/pairing | `:78-248`, `:1032-1093` |
| `lib/network.js` | adapter enumeration + remote-access lifecycle | `:280-443`, `:3064-3097` |
| `lib/show-state.js` | the `currentX` globals with a **single** default factory | `:1575-1665` |

**Duplication to kill while you are in there:**

- `resetServerStateForTests` ([server.js:2015-2086](server.js)) **re-declares every default literal**
  already written at `:1606-1662`, including the 12-line `currentSabhaState` style object verbatim
  twice. Any new state field must be added in two places or tests silently leak state. A single
  `createDefaultState()` used by both is the fix, and it is a prerequisite for the `lib/show-state.js`
  extraction.
- `sendGlossaryResult` (`:2107-2111`) and `sendSocketResult` (`:2113-2117`) are byte-identical.
- `isLocalSocket` / `onLocalSocket` are defined **twice** — [server.js:225-248](server.js) and
  [main.js:416-432](main.js) — with subtly different ack detection. This divergence is the root cause
  of the `atem_disconnect` unused-`payload` landmine that [main.js:681-688](main.js) documents rather
  than fixes. Export one implementation from `server.js` and import it in `main.js`.
- The `stage_timer` replay block is copy-pasted at `:2215-2219` and `:2555-2559`.
- The three `display-removed` window checks ([main.js:775-798](main.js)) are the same 8 lines three
  times.

**Dead code to delete:** unused `const session = ...` at [server.js:1036](server.js) (recomputed on
the next line); `serverHost` ([server.js:75](server.js)) written at `:3031`/`:3124`, never read;
`getDefaultNdiStatus` ([ndi_output_service.js:302-304](ndi_output_service.js)), no callers. Also drop
the pointless `async` on `show_lower_third` / `show_lyrics` (`:2304`, `:2332`) — neither awaits.

### P2.6 — Global shortcuts hijack arrow keys OS-wide for the app's entire lifetime

```js
const CLICKER_NEXT_KEYS = ['PageDown', 'Right', 'Down', 'MediaNextTrack'];  // main.js:39-40
const CLICKER_PREV_KEYS = ['PageUp', 'Left', 'Up', 'MediaPreviousTrack'];
```

Registered via `globalShortcut.register` ([main.js:50](main.js)) unconditionally at
`app.whenReady()` ([main.js:505](main.js)) and released only at `before-quit` (`:813`). An OS-level
global hotkey **consumes** the keystroke: while Broadcast Controller runs, arrow keys and
PageUp/PageDown stop working in **every other application on the machine**. The comment at
[main.js:33-38](main.js) shows the hazard was already understood for Space — the argument applies with
more force to arrow keys.

**Fix:** register only while a presentation is actually live (and ideally only while the app is not
focused, since in-window handling covers the focused case), and unregister as soon as it ends.

### P2.7 — Frontend duplication and god-components

**Four hand-rolled socket bootstraps, all slightly different** — `App.jsx:337-355` (socket in state),
`GraphicsApp.jsx:15` and `BackstageApp.jsx:7` (module scope), `RemotePadApp.jsx:165-195` and
`RemoteSlidesApp.jsx:124-153` (in-effect with `close()`). The `connect_error` → drop-token recovery
block is written three times almost verbatim, and the wake-lock effect is **byte-identical** between
`RemotePadApp.jsx:198-222` and `RemoteSlidesApp.jsx:156-180` (25 lines, zero diff).
`DEFAULT_LAYER_VISIBILITY` is defined twice identically (`App.jsx:21-30`, `GraphicsApp.jsx:17-26`).

**Fix:** a `useBroadcastSocket(remoteToken)` hook, a `useWakeLock()` hook and a shared `constants.js`
remove ~150 lines and make all four surfaces behave consistently on reconnect. Do this **before** the
panel splits below — it is the change that makes the rest easier.

**God-components, in order of payoff:**

- **`MediaPanel.jsx` (1654 lines, 54 `useState`, zero `useCallback`/`useMemo`)** bundles seven
  unrelated concerns. Two are trivially separable and already gated behind a settings toggle: the
  particle FX controls and the message-overlay typography (`:114-136`). Scheduled plays
  (`:543-607` + its UI) is self-contained with its own storage key → `ScheduledPlaysPanel`.
- **`App.jsx` (1502 lines, 32 `useState`, 27 `useEffect`)** — roughly 420 lines (`:1022-1437`) is a
  Settings page rendered inline. Extract `SettingsPanel`.
- **`TranslationPanel.jsx` (1486 lines)** — at least 400 lines are static help/docs modals
  (`:1417-1426` walks the user through Azure signup). Move to static content.
- **`LyricsPanel.jsx` (914 lines)** — 38 `useState`, mostly individual typography fields (`:32-40`)
  that should be one `style` object or a reducer. This also fixes the 21-entry dependency array at
  `:491` that re-attaches a window `keydown` listener whenever the font colour changes.

**Dead code and inert config to delete:**

| Item | Location |
|---|---|
| `movePlaylistItem`, `movePhotoItem`, `handlePlayCurrent` — three unused functions, ~35 lines | `MediaPanel.jsx:609`, `:748`, `:852` |
| `SavedConnections.jsx` (66 lines) — imported nowhere | `frontend/src/components/SavedConnections.jsx` |
| Imports `applyAnimationIn` / `applyAnimationOut` and uses neither, hand-rolling `gsap` instead | `graphics/TranslationGraphic.jsx:4` |
| `tailwind.config.js` is **inert** — Tailwind v4 does not auto-load it without an `@config` directive, and there is none. Its `content` globs and `darkMode: 'class'` do nothing; dark mode actually comes from `index.css:2` | `frontend/tailwind.config.js` |
| `autoprefixer` — redundant under Tailwind v4 (Lightning CSS prefixes internally) | `postcss.config.js`, `package.json` |
| 5 production `console.log`s, one on the on-air renderer's hot path (`'Received Sabha State:'` on every timer event) | `SabhaTimerGraphic.jsx:67`, `MediaGraphic.jsx:254`, `:315`, `TranslationPanel.jsx:278`, `:287` |
| 6 extraneous packages from a stale install (`@emnapi/*`, `@napi-rs/wasm-runtime`, `@tybys/wasm-util`, `tslib`) — a clean `npm ci` clears them | `frontend/node_modules` |

**Lint is currently failing:** `npx eslint .` reports **3 errors and 16 warnings** — a
`react-hooks/static-components` error at `PadButton.jsx:113` ("Cannot create components during
render"), two fast-refresh export errors (`RemotePairing.jsx:5`, `RemoteQr.jsx:7`), and 16 warnings
that are mostly the missing-dependency and unused-variable findings listed above. Clear these to zero
before wiring lint into CI (P3.3), otherwise the gate is useless.

**Styling inconsistency:** `BackstageApp.jsx:21-29` defines a local design-token object with hardcoded
hex arbitrary-values (`#4a443a` recurs at `:23`, `:26`, `:137`, `:142`, `:160`…) while the rest of the
app uses semantic classes from `index.css` (`surface`, `surface-raised`, `control-button`,
`control-field`, `section-rule`). Move that palette into the Tailwind theme or adopt the semantic
classes.

---

## P3 — Tests and CI

### P3.1 — Make the ack-shape hang impossible

`emitWithAck` ([tests/server-socket.test.js:140](tests/server-socket.test.js)) has no timeout, unlike
its sibling `waitFor` (`:43`, which takes `{ timeout = 1000 }`). The
"every handler must be `(payload, ack)`" invariant is currently enforced by **prose comments only**
(`:988-993`, `:1648-1649`). A future single-param handler produces a 30s opaque hang.

**Fix:** race `emitWithAck` against a 1s rejection with a message naming the ack-shape gotcha. Cheap,
and it turns the worst debugging experience in this repo into a one-line failure.

### P3.2 — Coverage gaps, ranked

1. **`main.js` — 820 lines, zero tests.** All ATEM socket wiring (`atem_connect`, `atem_push_boxes`,
   `atem_push_properties`, `atem_set_armed`), all NDI wiring, five IPC dialogs, the permission
   handler, the header rewriter, window lifecycle for four window types. `atem_service.js` is well
   tested; the socket→service wiring is not, and bugs there are the ones that take a service off-air.
2. **`ndi_output_service.js` — 304 lines, zero tests**, and currently *untestable*: it constructs
   `BrowserWindow` directly with no injection seam. `AtemService` shows the right pattern —
   constructor injection (`createAtem`), which `tests/atem-service.test.js:112-117` uses. Add the
   equivalent seam, then test the `sessionId` stale-frame rejection and `isSendingFrame` reentrancy
   guard.
3. **Zero React component tests** — there is no test runner in `frontend/package.json` at all. ~90%
   of 18.7k frontend lines uncovered, including `MediaPanel.jsx` (1654), `App.jsx` (1502),
   `TranslationPanel.jsx` (1486). Start with the untested *pure* utils, which need no runner
   changes: `backstageCueSheet.js` (202), `presentation.js` (115), `performance.js` (112),
   `padClick.js` (56).
4. **HTTP scrapers untested** — `/fetch-google-sheet`, `/fetch-anirdesh`, `/search-anirdesh`,
   `/fetch-youtube-playlist`, `/stream-video` Range handling. The *parsers* are the failure-prone
   part; isolate them so they can be tested against captured fixtures.
5. **`translation_worker.js` and `local_translation_worker.js` export nothing** and are tested only
   indirectly through the `FakeWorker` lifecycle. Export the request-building functions and test them.

**Extend the pattern that already works:** the contract test at
[tests/server-socket.test.js:1822](tests/server-socket.test.js) — *"every pad emit action targets an
event the server actually handles"* — imports `PAD_EMIT_ACTIONS` from the frontend model and asserts
each maps to a live handler. It is the only test of its kind and exactly the right idea. Generalise
it to cover the other ~60 socket events so frontend/backend drift fails a test instead of a show.

### P3.3 — CI runs no tests

`.github/workflows/build-macos.yml` is the only workflow. It has **no test step and no lint step**,
and there is no Windows workflow at all despite `npm run build:win` being documented.

**Fix:** add a `test` job (Node 22, `npm ci` + `npm --prefix frontend ci` + `npm test` +
`npm --prefix frontend run lint`) running on push and PR, and a Windows build workflow mirroring the
macOS one. Add `"engines": { "node": ">=22" }` to both `package.json` files — README says 18, CI pins
22, and `node --test` glob expansion needs 22, so an 18 user gets a working app and a broken suite
with a confusing module-resolution error.

---

## P4 — Build scripts and docs

| Item | Location | Fix |
|---|---|---|
| **`C:\tmp` hardcoded twice** for the node-gyp devdir and a generated `.cmd` — not a Windows convention, ignores `%TEMP%`, fails on a locked-down machine. The mac sibling correctly uses `os.tmpdir()` | [scripts/rebuild-ndi-win.js:68,71](scripts/rebuild-ndi-win.js) | `fs.mkdtempSync(path.join(os.tmpdir(), ...))`, and move cleanup into a `finally` (currently leaks the temp `.cmd` if the spawn throws) |
| **Fails silently** (`process.exit(0)`) when the electron binary is missing, then `npm start` dies with electron's own confusing error. Every sibling script fails loudly with an actionable message | [scripts/ensure-electron-path.js:26](scripts/ensure-electron-path.js) | fail loudly, matching the siblings |
| **Fat Mach-O arch check reads `nfat_arch` as cputype** — accepts `0xcafebabe`/`0xbebafeca` then reads offset 4 as CPU type, which in a fat binary is an arch *count*. A universal `grandiose.node` would fail with a misleading "not x64" message or pass by coincidence | [scripts/verify-ndi-mac.js:38](scripts/verify-ndi-mac.js) | parse fat headers properly, or reject fat binaries explicitly |
| **DMG rename is coupled to electron-builder's default artifact name** and `renameIfExists` swallows a miss — you can silently ship an x64 DMG named as if universal | [scripts/build-mac.js:42](scripts/build-mac.js) | fail loudly when the expected file is absent |
| **README says Node 18**; CI pins 22; tests need 22 | [README.md:50](README.md) | say 22, and add `engines` (P3.3) |
| **Testing is entirely undocumented** — no mention of `npm test`, or that it requires `npm --prefix frontend install` first | README | document both, and why |
| **No mention of where data lives** — an operator has no way to learn that the song/deck libraries are in browser localStorage, that Clear Cache wipes them, or that API keys are stored there in plaintext | README | document it; pairs naturally with the export/import feature in P2.2 |
| Project layout omits `atem_service.js`, `tests/`, the three `*_translation_worker.js` | README | add them |

**Dependencies** are in good shape — `npm ls --depth=0` is clean, the lockfile is consistent, and the
8-entry `overrides` block is doing real CVE-patching work. Two notes: `express@4.22.1` is a major
behind (v5's stricter `path-to-regexp` needs a route review before upgrading — see
`/api/presentation/slide/:index` at [server.js:1512](server.js)); and `@stagetimerio/grandiose@0.2.0`
is a pre-1.0 single-vendor native addon that downloads the NDI SDK at install time — the least
auditable dependency in the tree and a headline feature. Neither is urgent; both are worth knowing.

**Frontend deps** are all used (no unused runtime dependencies) and on recent minors. Largest gaps:
`lucide-react` 1.14.0 → 1.29.0, `tailwindcss` 4.2.4 → 4.3.3, `vite` 8.1.0 → 8.2.1, `eslint` 10.3.0 →
10.8.0, `react` 19.2.5 → 19.2.8. Bump these **after** the lint cleanup in P2.7, so a lint delta from
a new ESLint version doesn't get confused with the fixes.

---

## Suggested commit sequence

P0 items are independent; everything else assumes them. Within the later phases the ordering below
matters because each step makes the next cheaper.

1. **P0.2** (crash fix + global handlers) — smallest, and it protects you while you do everything else.
2. **P0.1** (`requireLocalAuth` on the six HTML routes) + its regression test.
3. **P0.3, P0.4, P0.6** — one commit each.
4. **P0.5, P0.7** — Electron hardening and the CDN/credential fixes; both need a manual smoke test.
5. **P1.0** (error boundaries) — do this before touching any graphics component, so a refactor
   mistake degrades instead of blanking output.
6. **P3.1** (`emitWithAck` timeout) — do it before writing the rest of the tests.
7. **P1.1–P1.5** (backend hot paths), then **P1.6–P1.12** (frontend render paths).
8. **P2.7's shared hooks** before any panel split; **P2.5's `createDefaultState()`** before any
   `server.js` module extraction.
9. Everything remaining in P2, then P3.2/P3.3, then P4.

---

## Verification

Run after **each** P0 item, not just at the end.

```bash
npm test
```

**Automated:**

1. `npm test` — 221 tests must stay green. Every P0 item above names a specific regression test to
   add to `tests/server-socket.test.js`.
2. `npm --prefix frontend run lint` — currently 3 errors / 16 warnings; drive to zero (P2.7).
3. `npm run build:frontend` must succeed before any manual run. After P1.11, check the emitted
   `public_react/assets/` sizes: `main-*.js` should drop well below its current 394 KB.

**Manual smoke test on the real app** (`npm start`) — this is a live-production tool and the socket
fan-out changes are not fully covered by tests:

1. **Privilege split (P0.1):** enable Remote Operators, pair a phone, then on that phone navigate to
   `http://<lan-ip>:<port>/` → must be **403**. View source on the remote pages → no
   `__BC_AUTH_TOKEN__`. The desktop control window must still work normally.
2. **Crash resistance (P0.2):** with the app running, connect a socket with
   `auth: { token: 'é'.repeat(64) }` → connection rejected, **app still running**, and the desktop
   window still responsive.
3. **Media (P0.3):** pick a local video through the file dialog, confirm it plays in graphics output,
   and confirm `/local-video?path=C:\Windows\...` no longer resolves.
4. **NDI (P1.1, P1.4):** start NDI output, confirm a receiver still shows a smooth 30 fps feed and the
   fps/receiver count still updates in Settings (now at 1 Hz). Watch main-process CPU before/after —
   it should drop.
5. **ATEM (P1.2):** drag a SuperSource box and confirm the move is still smooth and remotes still see
   updates.
6. **Decks (P2.2):** import a 30-slide PDF, restart the app, confirm the deck is **still there** —
   this is the failure the current build has.
7. **Shortcuts (P2.6):** with the app running and no presentation live, confirm arrow keys work
   normally in another application.
8. **Error boundaries (P1.0):** temporarily throw inside one graphics layer and confirm the *other*
   layers keep rendering rather than the whole output window going black.
9. **Offline (P0.7):** disconnect the machine from the internet, then import a PDF deck and show a
   lower third — both must work, and the lower third must render in its configured font rather than a
   system fallback.
10. **Graphics listeners (P1.6, P1.7):** run a lyrics set and a live translation session for a few
    minutes with devtools open on the graphics window; confirm no captions are dropped and that
    listener counts stay flat (`socket.listeners('translation_update').length`).

---

## Implementation notes — where the plan was wrong

Three items could not be done as written, because the codebase contradicted an assumption in the
audit. Recording them so the reasoning isn't lost:

1. **P0.4 said to make `pres_update` local-only. That would have broken the slides remote.**
   `RemoteSlidesApp.jsx:278` legitimately emits `pres_update` to load Google Slides / Canva decks,
   which are URL-based and carry no image data. The shipped rule instead shape-checks and
   size-caps the payload for *everyone*, and restricts only **inline image data** to local
   sockets. Same hole closed, feature intact.

2. **P0.3 implied `/stream-video` and `/local-image` could be local-only. They cannot.**
   An existing test (`remote clients cannot stream unregistered local media paths`) encodes a
   deliberate design decision: remotes *may* stream media, but only via an opaque `mediaId`. Those
   routes stayed on `requireAuth`; removing the `?path=` fallback is what actually closed the
   arbitrary-file-read. Only the desktop-authoring scrapers moved to `requireLocalAuth`.

3. **P1.4's HiDPI fix isn't available.** There is no supported per-window device-scale override in
   Electron (`webPreferences.deviceScaleFactor` is not a real option and is silently ignored), and
   the app-level switch would affect the control UI too. The per-frame `image.resize()` on HiDPI
   remains; it is correctly skipped when sizes already match. The per-frame *status broadcast*
   (the far larger cost) was removed as planned.

Also worth noting: **`pdfjs-dist@3.11.174` — the exact version the CDN was serving — carries a
known high-severity advisory.** Pinning it would have preserved a real vulnerability, so it went
in at v6 instead. `npm audit` is now clean in both packages (it was not before).

---

## Deferred, with reasons

- **P2.5 full `server.js` module split.** The two changes that made it *urgent* are done: the
  duplicated default-state literals are now shared factories (`createDefaultSabhaState` and
  friends), so a new state field can no longer be added in one place and forgotten in the other,
  and the duplicated `isLocalSocket`/`onLocalSocket` in `main.js` now import the single
  implementation from `server.js`. The remaining six-module extraction is pure code movement with
  no behavioural payoff, and it would make every other change in this batch hard to review. Worth
  doing on its own, against a green suite, not bundled with security fixes.
- **P1.10's "lift panel state into a store".** Panels are still all mounted; only `SuperSourcePanel`
  is lazy. The audit's own evidence says `PadLayoutPanel` *must* stay mounted to keep publishing
  its layout, and I could not establish the same for the other panels without running each one
  through a live service. Deferring beats silently breaking a panel that publishes on mount.
- **P3.2's broader test coverage** (component tests, `ndi_output_service` injection seam). Nine new
  backend regression tests were added covering every P0 fix and the P2 correctness bugs; the
  frontend still has no component test runner.

---

## What was verified

- `npm test` — **230/230 pass** (was 219/221; the two pre-existing failures were platform-blind
  test fixtures, now fixed).
- `npm --prefix frontend run lint` — **0 errors, 6 warnings** (was 3 errors, 16 warnings). The
  remaining warnings are `exhaustive-deps` on graphics effects where adding the deps would
  reintroduce the re-subscription churn P1.6 exists to remove.
- `npm audit` — **0 vulnerabilities**, root and frontend (was 5 high + 2 high).
- App launched via Electron and exercised over HTTP:
  - `GET /` unauthenticated → **403**
  - `GET /remote` → 200 and contains **zero** occurrences of `__BC_AUTH_TOKEN__`
  - `GET /remote.html` (the static bypass) → **404**
  - `GET /stream-video?path=C:/Windows/win.ini` → **403**
  - unknown route → **404** (new handler)
  - `/fonts/latin/Inter-latin-normal-400.woff2` → **200**, `font/woff2`, and the built CSS
    references `/fonts/latin/` — so the graphics output no longer needs the internet for type.
  - GPU acceleration confirmed active on the Radeon 780M; no load errors.

**Still needs a human at the desk:** NDI output to a real receiver, an ATEM SuperSource drag, and
a PDF import round-trip (import → restart → deck still there). Those are the three changes whose
payoff can't be observed without the hardware.

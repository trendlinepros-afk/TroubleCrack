# TroubleCrack

An AI-supervised repair console for Windows machines. TroubleCrack drives a
[JetKVM](https://jetkvm.com) to troubleshoot a physical computer over KVM —
including machines that **cannot boot** — while a human administrator supervises
every step. It can also repair the computer it runs on (**Local mode**), where it
uses real PowerShell execution instead of screenshot-driving the desktop.

The agent is a *supervised repair loop*, not a free agent: a plain-code state
machine owns the process and Claude does perception and per-step execution, with
approval gating, a hard destructive-action blocklist, and hard per-session caps.

> **Status / hardware verification.** Milestones 1–8 are implemented. The KVM
> hardware paths (WebRTC video, HID control, boot watching) are built from the
> JetKVM source but require real hardware to verify end-to-end — see
> **[Verifying against real hardware](#verifying-against-real-hardware)** and
> [`docs/HARDWARE_TEST_CHECKLIST.md`](docs/HARDWARE_TEST_CHECKLIST.md). Local mode
> is fully testable with zero hardware.

---

## Architecture

```
┌────────────────────────── Electron ──────────────────────────┐
│  Renderer (React + TypeScript)          Main (Node + TS)      │
│  ─ UI panels                            ─ Orchestrator (state │
│  ─ KvmClient: WebRTC video +              machine)            │
│    JSON-RPC HID over the "rpc"          ─ Anthropic client    │
│    data channel                           (computer-use loop) │
│  ─ Frame capture (video→canvas→JPEG)    ─ Backends: Kvm/Local │
│  ─ Manual takeover passthrough          ─ Vault I/O           │
│                                         ─ Auto-update         │
│         │  KVM bridge (IPC)  ▲            │                   │
│         ▼                    │            ▼                   │
│   commands / frames    results      WebRTC signaling in main  │
└──────────────────────────────────────────────────────────────┘
                                   │
                        JetKVM  ◀──┘  (HTTP: /auth/login-local,
                                        /webrtc/session)
```

- The **renderer** owns the JetKVM connection because Chromium speaks WebRTC
  natively. It captures video frames, draws them to a canvas, and exports JPEG
  for the model; it executes HID actions over the JetKVM's JSON-RPC data channel.
- The **main process** runs the orchestrator, calls the Anthropic API with the
  computer-use tool, scales coordinates back to the KVM's absolute mouse space,
  **discovers the JetKVM's current IP** (mDNS + subnet scan) and does the WebRTC
  HTTP signaling (to avoid browser CORS/SameSite limits), and handles vault I/O
  and auto-updates. The JetKVM IP is treated as ephemeral — only a stable device
  identity is stored, and the IP is re-resolved on launch and on any reconnect.
- One `TargetBackend` interface abstracts the target: **KvmBackend** (screenshots
  + HID) and **LocalBackend** (`run_powershell` + diagnostics + optional
  screenshot). The orchestrator, approval flow, attempt history, chat, and vault
  learning are identical in both modes.

The JetKVM protocol was implemented from their firmware source, not assumption —
see [`docs/JETKVM_PROTOCOL.md`](docs/JETKVM_PROTOCOL.md).

### Project layout

```
src/main       orchestrator, state machine, boot watcher, backends,
               anthropic client, vault, updater, settings, IPC
src/renderer   React UI, KvmClient (WebRTC + HID), manual takeover
src/preload    contextBridge exposing the typed window.api
src/shared     types, IPC contract, playbooks-as-data, blocklist, HID map
tests          unit tests (state machine, vault, blocklist, boot watcher, …)
```

---

## Setup

Requires **Node 22+** and **npm 10+**.

```bash
npm install
npm run dev        # launch in development (electron-vite)
npm test           # run the unit tests
npm run typecheck  # strict TypeScript typecheck (main + renderer)
npm run build      # typecheck + build all three bundles
npm run dist       # build a Windows x64 NSIS installer (release/)
```

### First-run configuration (Settings page)

1. **Anthropic API key** — stored encrypted at rest via Electron `safeStorage`
   in the app's `userData` directory, which is **preserved across auto-updates**
   (updates replace the install dir, not `userData`; `deleteAppDataOnUninstall`
   is off). The plaintext key never leaves the main process. Click **Test
   discovery & key** to validate.
2. **JetKVM device** — the IP is **never entered or stored**; it is DHCP-assigned
   and resolved automatically. Click **Discover devices** (mDNS + a local-subnet
   scan), pick your JetKVM, and set the auth mode / password. Only the stable
   device identity is saved; the current IP is re-resolved on every connect. A
   manual IP field exists as a last resort.
3. **Obsidian vault** (optional) — pick a folder; TroubleCrack writes notes under
   `<vault>/TroubleCrack/`. Validation confirms the folder is writable. Missing or
   unwritable vaults degrade gracefully — a repair never blocks on a note.
4. **Model** and **safety caps** (max iterations / spend / wall-clock).

---

## JetKVM pairing

1. Set up the JetKVM per [jetkvm.com/docs](https://jetkvm.com/docs). You do **not**
   need its IP — TroubleCrack discovers it.
2. In TroubleCrack **Settings → JetKVM device**, click **Discover devices**. This
   tries mDNS (an A-query for `jetkvm-<id>.local`) and a fingerprinted local-subnet
   scan (`GET /device/status`). Pick your device from the list. Its stable
   identity is stored; the IP is re-resolved automatically thereafter (on launch
   and on any connection loss), so it keeps working across DHCP changes and
   networks.
3. If the device has **local auth** enabled, set the same password. TroubleCrack
   logs in via `/auth/login-local` in the main process and reuses the `authToken`
   cookie for the WebRTC session request; it also reads `GET /device` to capture
   the device id for future mDNS re-resolution.
4. Plug the target machine's video into the JetKVM and its USB (HID) into the
   target so keyboard/mouse are emulated.
5. Select **JetKVM device** as the target, enter a machine description and the
   problem, and press **Start** — or use **Take over (manual)** in the preview to
   drive it yourself first.

---

## Using it

- **Session bar:** pick the target (JetKVM / This computer), describe the machine
  and problem, then Start / Pause / Stop. Toggle **Approval** (default — every
  action needs a click) vs **Auto** (a hard blocklist still forces approval for
  destructive actions). Elapsed time and estimated API spend show live.
- **Live Preview:** the WebRTC stream (KVM) or a live command transcript (Local),
  with a connection badge and **manual takeover**. On KVM targets the agent can
  **zoom** — request a high-resolution crop of any region (native-resolution,
  upscaled) so small or unreadable text (stop codes, dialog fine print) is legible
  without disturbing its screenshot baseline.
- **Now:** the agent's running narration and pending approval requests.
- **Attempted Fixes:** the session's step-by-step history with outcomes, and
  **Export… / Copy** buttons that produce a Markdown summary of the steps taken —
  available **during** a session (progress so far) and **after** it ends. The
  summary covers the machine/problem, status, duration, each step and its outcome,
  the full activity log, admin chat, and estimated cost — ready to paste into a
  ticket. Also available from **Session → Export Summary…** (`Ctrl+E`) and **Copy
  Summary** (`Ctrl+Shift+E`). A summary is **also written automatically when a
  session ends** (on by default) to `Documents/TroubleCrack/` — change the folder
  or turn it off under **Settings → Session summaries**; the *Now* feed shows where
  each file was saved.
- **Admin Chat:** free-text guidance injected as high-priority context. With no
  session running, describe a problem and the agent offers to start a Local
  session.

Before a repair is declared **fixed**, a **second-opinion** check runs — a fresh,
skeptical cross-check (a new screenshot re-examined against the original problem on
KVM; a review of the agent's own reasoning and actions on Local). If it can't
confirm the fix, the run keeps working rather than stopping early; a check that
errors out never vetoes a genuine fix.

### Desktop app conveniences

TroubleCrack behaves like a native desktop app, not a web page:

- **Application menu** with real accelerators — **Settings** (`Ctrl+,`), **New
  Session** (`Ctrl+N`), **Stop Session** (`Ctrl+.`), zoom, full-screen, and
  **Open Logs Folder** under Help. `Esc` leaves the Settings page.
- **Background attention:** when the window isn't focused, a needed approval, a
  stall that needs a human, or a finished session raises an **OS notification** and
  flashes the taskbar. Clicking the notification brings the window forward.
- **Live window title** reflects state (`● Repairing…`, `⏸ Paused`, `⚠ Approval
  needed`, `✓ Fixed`).
- **Remembers its layout** — window size/position (and maximized state) and the
  side-panel width persist across launches.
- **Quit guard:** closing the window mid-repair asks before stopping the session.
- **Onboarding:** a first-run banner points a new operator at the API-key field,
  and the Start button explains exactly what it's still waiting for.

### Local mode

Local mode repairs the computer TroubleCrack runs on. It is command-line-first
(`run_powershell` plus Event Viewer / service / disk / network helpers), which is
faster and more reliable than screenshotting the desktop. Many fixes need admin
rights: if the app is not elevated, it says so and offers **Relaunch as
Administrator** (via the Windows UAC prompt — never silent elevation). Safety is
doubled here — the destructive blocklist plus registry deletions, `Remove-Item
-Recurse` outside temp, and disabling security services all force approval.

---

## Verifying against real hardware

Milestone 2 (KvmClient + live preview + manual takeover) is intended to be a
usable manual KVM on its own. To verify the hardware paths:

1. `npm run dev`, open **Settings → JetKVM device**, click **Discover devices**,
   and pick your JetKVM (set a password if it uses one). **Test discovery & key**
   should resolve it.
2. Select **JetKVM device**, and in the Live Preview you should see the target's
   screen within a few seconds; the badge reads **Connected**.
3. Click **Take over (manual)** and confirm your mouse and keyboard drive the
   target. Try a boot-menu key (e.g. F12) at power-on.
4. Pull the network / power-cycle the JetKVM (or force a DHCP lease change) and
   confirm the badge shows **Reconnecting…**, that discovery finds the new IP, and
   that it recovers on its own.

Run the full manual matrix in
[`docs/HARDWARE_TEST_CHECKLIST.md`](docs/HARDWARE_TEST_CHECKLIST.md) before relying
on the automated repair loop against production machines.

---

## Auto-update

Distributed via **GitHub Releases**. `electron-updater` checks on launch and
daily; when an update downloads it prompts **Restart now / Later** and installs on
quit. Updates are **never** applied mid-session — if a repair is running, the
prompt is deferred until it ends. Tag a release (`vX.Y.Z`) to trigger the
[release workflow](.github/workflows/release.yml), which builds the NSIS installer
and publishes it.

> The installer icon uses Electron's default unless you add `build/icon.ico`.

---

## Safety model

- **Approval mode (default ON)** in both KVM and Local mode: every action is shown
  and requires a click, with an "auto-approve this step" option.
- **Hard blocklist** forces approval even in Auto mode: `format`, destructive
  `diskpart` (`clean`/`delete`), `del /s`, partition changes, BIOS changes,
  BitLocker, and (Local) registry deletions, `Remove-Item -Recurse` outside temp,
  and disabling security services / Defender.
- **BitLocker / power** are never guessed or brute-forced; the agent pauses and
  asks the admin.
- **Hard caps** per session (iterations, estimated spend, wall-clock) → NEEDS_HUMAN,
  never a crash.
- Every external connection retries with exponential backoff and surfaces a
  plain-English status; errors are logged to a rotating `electron-log` file and
  summarized to the UI — no raw stack traces on screen.

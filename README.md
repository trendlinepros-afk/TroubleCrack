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
  does the WebRTC HTTP signaling (to avoid browser CORS/SameSite limits), and
  handles vault I/O and auto-updates.
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

1. **Anthropic API key** — stored encrypted at rest via Electron `safeStorage`.
   The plaintext key never leaves the main process. Click **Test connection & key**
   to validate.
2. **JetKVM address** — host or `host:port`. Choose the auth mode (`Auto`,
   `Password`, or `No password`) and set the device password if required. **Test
   connection & key** checks reachability.
3. **Obsidian vault** (optional) — pick a folder; TroubleCrack writes notes under
   `<vault>/TroubleCrack/`. Validation confirms the folder is writable. Missing or
   unwritable vaults degrade gracefully — a repair never blocks on a note.
4. **Model** and **safety caps** (max iterations / spend / wall-clock).

---

## JetKVM pairing

1. Set up the JetKVM per [jetkvm.com/docs](https://jetkvm.com/docs) and note its
   LAN IP (its web UI is at `http://<ip>/`).
2. If the device has **local auth** enabled, set the same password in
   TroubleCrack Settings. TroubleCrack logs in via `/auth/login-local` in the main
   process and reuses the `authToken` cookie for the WebRTC session request.
3. Plug the target machine's video into the JetKVM and its USB (HID) into the
   target so keyboard/mouse are emulated.
4. In TroubleCrack, select **JetKVM device** as the target, enter a machine
   description and the problem, and press **Start** — or use **Take over (manual)**
   in the preview to drive it yourself first.

---

## Using it

- **Session bar:** pick the target (JetKVM / This computer), describe the machine
  and problem, then Start / Pause / Stop. Toggle **Approval** (default — every
  action needs a click) vs **Auto** (a hard blocklist still forces approval for
  destructive actions). Elapsed time and estimated API spend show live.
- **Live Preview:** the WebRTC stream (KVM) or a live command transcript (Local),
  with a connection badge and **manual takeover**.
- **Now:** the agent's running narration and pending approval requests.
- **Attempted Fixes:** the session's step-by-step history with outcomes.
- **Admin Chat:** free-text guidance injected as high-priority context. With no
  session running, describe a problem and the agent offers to start a Local
  session.

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

1. `npm run dev`, open **Settings**, set the JetKVM address (+ password if used),
   and **Test connection & key** — expect a green "Reachable" result.
2. Select **JetKVM device**, and in the Live Preview you should see the target's
   screen within a few seconds; the badge reads **Connected**.
3. Click **Take over (manual)** and confirm your mouse and keyboard drive the
   target. Try a boot-menu key (e.g. F12) at power-on.
4. Pull the network / power-cycle the JetKVM and confirm the badge shows
   **Reconnecting…** and recovers on its own.

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

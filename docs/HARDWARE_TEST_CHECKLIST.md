# Manual hardware test checklist

The unit tests cover the orchestrator state machine, boot-watcher decision logic,
vault I/O, the blocklist, the HID keymap, and the playbooks. The paths below
touch **real hardware** (a JetKVM + a target machine) or the **local OS**, so they
must be verified by hand. Work top to bottom; each item lists the expected result.

Legend: ☐ = to test.

## A. Discovery, settings & connectivity

- ☐ **Discovery (mDNS + scan)** — Settings → *Discover devices* → the JetKVM
  appears in the list (by IP, "configured/not set up"); the scan completes in a
  few seconds.
- ☐ **Pick a device** — *Use this* on the device → it's shown as the selected
  device; no IP is written to `settings.json` (check `%APPDATA%/TroubleCrack`).
- ☐ **mDNS re-resolution** — after connecting once (identity captured), change the
  JetKVM's DHCP lease / IP, then *Test discovery & key* → it re-resolves the new
  IP via `jetkvm-<id>.local` without re-entering anything.
- ☐ **No device** — with the JetKVM off, *Discover devices* → empty list + a clear
  "No JetKVM found" message; the app does not hang.
- ☐ **Manual IP (last resort)** — enter an IP → *Use IP* → next connect uses it and
  captures the identity; the IP itself is not persisted.
- ☐ **API key valid** — enter a real Anthropic key, *Test* → API row green.
- ☐ **API key invalid** — enter a bad key → red "rejected (401)".
- ☐ **Vault writable** — pick a real Obsidian folder → green "writable"; a
  `TroubleCrack/` subfolder is created.
- ☐ **Vault read-only** — pick a read-only path → red warning; the app still runs.
- ☐ **Secret persistence** — restart the app → API key still shows "stored"; no
  plaintext appears in `settings.json` (check `%APPDATA%/TroubleCrack`).

## B. KVM connection & video (Milestone 2)

- ☐ **Password auth** — with device local-auth on, connect → badge goes
  Connecting → Negotiating → **Connected**; video appears within a few seconds.
- ☐ **No-password mode** — with local-auth off, connect with auth mode *Auto* →
  connects without a password.
- ☐ **Video fidelity** — text on the target is legible in the preview.
- ☐ **Reconnect (with IP change)** — unplug the JetKVM network / power-cycle it (or
  force a new DHCP lease) → badge shows **Reconnecting… (attempt N)** with backoff;
  discovery re-resolves the (possibly new) IP and it recovers automatically. The
  app never white-screens.
- ☐ **App restart mid-connection** — kill and reopen the app → it starts clean and
  the previous session snapshot is shown (marked interrupted).

## C. Manual takeover (Milestone 2)

- ☐ **Mouse** — toggle *Take over (manual)*; moving/clicking in the preview moves
  the target cursor to the matching position (absolute positioning).
- ☐ **Keyboard** — type into a target text field; characters appear correctly,
  including shifted symbols.
- ☐ **Modifiers** — Ctrl+A, Ctrl+C/V behave; holding Shift for selection works.
- ☐ **Boot-menu key** — power the target and tap the vendor boot key (F12/F9/Esc/
  Del) → the boot menu opens.
- ☐ **Agent paused** — while manual control is ON, a running session does not
  issue actions; turning it OFF resumes.

## D. Frame capture → Claude → single action (Milestone 3)

- ☐ **Screenshot round-trip** — start a KVM session; the *Now* feed shows the agent
  taking a screenshot and proposing an action.
- ☐ **Coordinate accuracy** — an approved click lands on the intended on-screen
  element (validates the model→native→0..32767 scaling).
- ☐ **Approval flow** — in Approval mode every action shows an Approve/Deny card;
  Deny is honored and the agent adapts.
- ☐ **Auto-approve step** — "Approve + auto-approve this step" stops prompting for
  the rest of that step (but a blocklisted action still prompts).
- ☐ **Region zoom** — point at a screen with small text (e.g. a BSOD stop code or a
  dialog's fine print); the agent uses *zoom* to read it, and the zoomed crop is
  visibly higher-resolution than the full frame. The full-frame baseline is
  unchanged afterward (the next full screenshot still shows the whole screen).

## E. Orchestrator, playbook & boot watcher (Milestone 4)

- ☐ **Classification** — point at a machine in each state (desktop, BIOS, a BSOD,
  WinRE) and confirm the *Now* feed classifies it sensibly.
- ☐ **Reboot + boot watch** — after a step with `rebootAfter`, the agent reboots
  (Ctrl+Alt+Del) and the boot watcher polls up to 5 minutes, reporting FIXED /
  SAME_FAILURE / NEW_FAILURE.
- ☐ **Hard-frozen machine** — if Ctrl+Alt+Del does nothing, the feed prompts you to
  press the physical power button.
- ☐ **No repeat** — a step marked failed is not retried; the ladder advances.
- ☐ **Caps** — set a low iteration/spend/time cap → the session lands in
  NEEDS_HUMAN, never crashes.
- ☐ **BitLocker** — at a BitLocker recovery prompt, the agent pauses and asks for
  the key in chat rather than guessing.
- ☐ **Second opinion on FIXED** — when the agent believes it fixed the machine, a
  fresh skeptical re-check runs before the session reports FIXED (a new screenshot
  on KVM). If the problem clearly persists, the run continues instead of stopping;
  if the check errors, a genuine fix is still accepted.

## F. Local mode (Milestone 6 — no KVM hardware needed)

- ☐ **System info** — start a Local session; the agent reports OS/host/elevation.
- ☐ **run_powershell** — a read-only command (e.g. `Get-Service`) runs and its
  stdout/stderr/exit show in the transcript.
- ☐ **Elevation detection** — run un-elevated → an admin-only command fails with a
  clear "needs Administrator" note; *Relaunch as Administrator* triggers the UAC
  prompt and reopens elevated.
- ☐ **Local playbooks** — try each: network triage, stuck Windows Update, printer
  queue reset, disk cleanup, slow-machine triage.
- ☐ **Doubled blocklist** — a registry delete / `Remove-Item -Recurse` outside temp
  / disabling Defender each force an approval prompt even in Auto mode.
- ☐ **Idle chat → Local session** — with no session running, type a problem in
  chat; the agent offers a one-click *Start a Local session*.

## G. Vault self-learning (Milestone 7)

- ☐ **Write on FIXED** — finish a session that fixes the machine → a note appears
  in `<vault>/TroubleCrack/YYYY-MM-DD <slug>.md` with frontmatter + sections.
- ☐ **Write on GAVE_UP** — an exhausted session also writes a note ("Unresolved").
- ☐ **Read on start** — start a new session with similar symptoms → the *Now* feed
  says "Loaded lessons from past repairs" and the earlier note informs the agent.
- ☐ **Vault removed mid-run** — delete the vault folder during a session → the run
  continues; the write-back is skipped with a logged warning, no crash.

## H. Auto-update (Milestone 8)

- ☐ **Check for Updates** — with a published newer release, *Check for Updates*
  reports it and downloads in the background.
- ☐ **Restart prompt** — when downloaded, the banner offers *Restart now / Later*;
  Restart installs and relaunches.
- ☐ **Deferred during session** — if a repair is active when an update downloads,
  the prompt is deferred and only appears after the session ends.

## I. Robustness sweep

- ☐ **Anthropic outage** — block API egress mid-session → the feed shows ret/backoff
  status and recovers, or lands in NEEDS_HUMAN; no crash.
- ☐ **Log file** — confirm a rotating log exists under the app's logs directory and
  that no raw stack trace is shown in the UI.
- ☐ **Kill & resume** — kill the app during a session, reopen → the last snapshot
  (attempts, narration, cost) is restored for review.

## J. Native feel & intuitiveness

These don't need KVM hardware — Local mode (or no session) exercises them.

- ☐ **Application menu** — the menu bar has File/Edit/Session/View/Help with working
  accelerators: **Settings** (`Ctrl+,`), **New Session** (`Ctrl+N`), **Stop
  Session** (`Ctrl+.`). Edit's Copy/Paste/Select-All work in text fields.
- ☐ **Esc leaves Settings** — open Settings, press `Esc` → back to the session view.
- ☐ **New Session focus** — File → *New Session* (or `Ctrl+N`) switches to the main
  view and puts the cursor in the *Problem* field.
- ☐ **Onboarding banner** — with no API key stored, the main view shows a welcome
  banner with an *Add API key* button; Start is disabled with a tooltip that says
  why. The banner disappears once a key is saved.
- ☐ **Device hint** — in KVM mode with no device selected, a hint under the session
  bar links to Settings.
- ☐ **Window title** — the title tracks state: `● …`/`⏸ Paused`/`⚠ Approval
  needed`/`✓ Fixed`.
- ☐ **Background notifications** — with the window minimized/unfocused, trigger an
  approval (Approval mode) → an OS notification appears and the taskbar button
  flashes; clicking the notification brings the window forward. A finished session
  notifies too.
- ☐ **Quit guard** — close the window mid-session → a dialog asks before stopping;
  *Keep running* cancels the close, *Stop repair & quit* exits.
- ☐ **Remembers layout** — resize the window and drag the panel splitter, quit, and
  reopen → the same size/position and panel width are restored; maximize is
  remembered too.
- ☐ **Last view** — leave the app on Settings, reopen → it returns to Settings.
- ☐ **Reduced motion** — with the OS "reduce motion" setting on, list auto-scroll
  and card animations are instant rather than animated.
- ☐ **Export summary (mid-session)** — while a session is running, *Attempted fixes
  → Export…* saves a Markdown file; open it and confirm the steps so far, status,
  activity log, chat, and cost are present and readable.
- ☐ **Export summary (at end)** — after a session ends, export again → the file
  reflects the final status and every step.
- ☐ **Copy summary** — *Copy* (or `Ctrl+Shift+E`) puts the same Markdown on the
  clipboard; paste it elsewhere to confirm.
- ☐ **Export with no session** — from a fresh app (no session yet), *Session →
  Export Summary…* shows a friendly "nothing to export yet" dialog rather than
  failing; the in-panel buttons are disabled.

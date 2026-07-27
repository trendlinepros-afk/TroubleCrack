# Manual hardware test checklist

The unit tests cover the orchestrator state machine, boot-watcher decision logic,
vault I/O, the blocklist, the HID keymap, and the playbooks. The paths below
touch **real hardware** (a JetKVM + a target machine) or the **local OS**, so they
must be verified by hand. Work top to bottom; each item lists the expected result.

Legend: ☐ = to test.

## A. Settings & connectivity

- ☐ **Reachability** — enter the JetKVM address, click *Test connection & key* →
  KVM row shows a green "Reachable at host:port".
- ☐ **Bad address** — enter a wrong address → red "Could not reach…"; the app does
  not hang or crash.
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
- ☐ **Reconnect** — unplug the JetKVM network / power-cycle it → badge shows
  **Reconnecting… (attempt N)** with backoff, then recovers automatically when it
  returns. The app never white-screens.
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

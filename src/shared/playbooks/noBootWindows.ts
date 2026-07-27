import type { Playbook } from './types'

/**
 * The default KVM playbook: the no-boot Windows escalation ladder. Stored as
 * data so more playbooks can be added later without touching the orchestrator.
 * The orchestrator runs each step as a fresh Claude session seeded with the
 * step goal + machine context + a rolling summary of prior attempts.
 */
export const noBootWindows: Playbook = {
  id: 'no-boot-windows',
  title: 'Windows will not boot',
  mode: 'kvm',
  tags: ['no-boot', 'windows', 'boot', 'bsod', 'winre', 'bootrec'],
  steps: [
    {
      id: 'observe',
      name: 'Observe and classify the failure',
      goal:
        'Look at the current screen and classify the boot failure: BIOS/POST, ' +
        'vendor-logo hang, BSOD (read the stop code), boot-device-not-found, ' +
        'WinRE (recovery environment), spinning-dots loop, or black screen. On a ' +
        'black screen, press a key and re-check before concluding — it may be ' +
        'display sleep. Report the classification and any stop code precisely.',
      hints: [
        'On black screen: press a key (e.g. Space) then take a fresh screenshot.',
        'Read BSOD stop codes exactly (e.g. INACCESSIBLE_BOOT_DEVICE, 0x0000007B).'
      ],
      rebootAfter: false
    },
    {
      id: 'reach-command-line',
      name: 'Reach a command line',
      goal:
        'Get to a command prompt. WinRE usually auto-launches after two failed ' +
        'boots (Advanced options → Troubleshoot → Command Prompt). If it does ' +
        'not, boot the mounted Windows ISO via the target boot menu and press ' +
        'Shift+F10 at the setup screen to open a command prompt.',
      hints: [
        'Boot menu keys vary by vendor: F12 (Dell/Lenovo), F9 (HP), F8/Esc, or Del for BIOS.',
        'At Windows Setup, Shift+F10 opens a command prompt.',
        'The Windows ISO is mounted by TroubleCrack as USB media before this step.'
      ],
      requiresCommandLine: true,
      rebootAfter: false
    },
    {
      id: 'startup-repair',
      name: 'Startup Repair',
      goal:
        'Run Windows Startup Repair (WinRE → Troubleshoot → Advanced options → ' +
        'Startup Repair). Let it complete, then we reboot and re-check.',
      hints: ['From a command line: run "startrep" or use the WinRE Startup Repair tile.'],
      rebootAfter: true
    },
    {
      id: 'bootrec',
      name: 'Rebuild the boot records',
      goal:
        'From the command line, repair the boot configuration in order: ' +
        'bootrec /fixmbr, then bootrec /fixboot, then bootrec /rebuildbcd, then ' +
        'bcdboot C:\\Windows. If /fixboot returns Access Denied, that is expected ' +
        'on GPT/UEFI — continue with /rebuildbcd and bcdboot.',
      hints: [
        'bootrec /fixmbr',
        'bootrec /fixboot',
        'bootrec /rebuildbcd',
        'bcdboot C:\\Windows'
      ],
      requiresCommandLine: true,
      rebootAfter: true
    },
    {
      id: 'chkdsk-sfc-dism',
      name: 'Filesystem and image integrity',
      goal:
        'Repair disk and OS-image corruption from the command line: chkdsk C: /f, ' +
        'then offline SFC (sfc /scannow /offbootdir=C:\\ /offwindir=C:\\Windows), ' +
        'then offline DISM restorehealth against the offline image. Identify the ' +
        'correct Windows volume first (it may not be C: in WinRE).',
      hints: [
        'chkdsk C: /f',
        'sfc /scannow /offbootdir=C:\\ /offwindir=C:\\Windows',
        'DISM /Image:C:\\ /Cleanup-Image /RestoreHealth',
        'Use "bcdedit | find \"osdevice\"" or diskpart list volume to find the OS drive (read-only).'
      ],
      requiresCommandLine: true,
      rebootAfter: true
    },
    {
      id: 'uninstall-update',
      name: 'Uninstall the latest update',
      goal:
        'From WinRE, uninstall the most recent quality or feature update, which ' +
        'is a common cause of a machine that stopped booting after Windows Update ' +
        '(Troubleshoot → Advanced options → Uninstall Updates).',
      hints: [
        'WinRE has an "Uninstall Updates" tile: latest quality update or latest feature update.',
        'From DISM: DISM /Image:C:\\ /Get-Packages then /Remove-Package for the newest one.'
      ],
      rebootAfter: true
    },
    {
      id: 'safe-mode-driver',
      name: 'Safe Mode: disable recent driver/service',
      goal:
        'Boot into Safe Mode and disable the most-recently-changed driver or ' +
        'service that is likely causing the failure (for example a GPU or storage ' +
        'driver). Prefer disabling over deleting.',
      hints: [
        'Enable Safe Mode: bcdedit /set {default} safeboot minimal (revert after).',
        'Review recently-changed drivers by date; disable via Device Manager or "sc config <svc> start= disabled".'
      ],
      rebootAfter: true
    },
    {
      id: 'system-restore',
      name: 'System Restore',
      goal:
        'Roll back to a System Restore point from before the failure (WinRE → ' +
        'Troubleshoot → Advanced options → System Restore), if any restore points ' +
        'exist.',
      hints: ['rstrui.exe from a command line, or the WinRE System Restore tile.'],
      rebootAfter: true
    },
    {
      id: 'give-up-reimage',
      name: 'Give up gracefully and recommend reimage',
      goal:
        'Every recoverable avenue has been exhausted. Write a full report of what ' +
        'was observed and tried, and recommend reimaging the machine. Do not take ' +
        'any destructive action.',
      terminal: true,
      rebootAfter: false
    }
  ]
}

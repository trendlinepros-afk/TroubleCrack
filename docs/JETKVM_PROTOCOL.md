# JetKVM protocol — what the source actually does

Implemented from the JetKVM firmware source (`github.com/jetkvm/kvm`, files
`web.go`, `webrtc.go`, `jsonrpc.go`, `usb.go`, `internal/usbgadget/`), **not**
from assumption. This document records the exact behaviour the `KvmClient`
targets so the implementation can be checked against it.

## Authentication (`web.go`)

- Local auth has two modes, stored in the device config as `localAuthMode`:
  - `noPassword` — `/auth/login-local` is disabled; the protected routes are
    reachable without a cookie.
  - `password` — you must authenticate first.
- `POST /auth/login-local` with JSON body `{"password": "<pw>"}`.
  - On success the device sets an **HttpOnly `authToken` cookie** (1-week
    max-age) and returns `{"message":"Login successful"}`.
  - On failure it returns `401` and records a rate-limit failure keyed by client
    IP; too many failures returns `429` with a `Retry-After` header.
- All subsequent protected requests (notably `/webrtc/session`) must carry the
  `authToken` cookie.

`KvmClient` therefore: if a password is configured, POST `/auth/login-local`,
keep the `Set-Cookie` `authToken`, and send it on the session request. In
`noPassword` mode it skips login. In Electron the renderer's `fetch` runs in a
Chromium context, so the cookie is stored and replayed automatically for
same-origin requests; we still parse/track it for clarity and error reporting.

## WebRTC session negotiation (`web.go`, `webrtc.go`)

- `POST /webrtc/session` (protected) with body:
  `{"sd": "<base64>"}` where `<base64> = base64(JSON.stringify(offer))` and
  `offer` is a standard `RTCSessionDescription` (`{type:"offer", sdp:"..."}`).
- Response: `{"sd": "<base64>"}` where the decoded JSON is the **answer**
  `RTCSessionDescription`.
- The device adds an outbound **video track** (`webrtc.NewTrackLocalStaticSample`,
  mime negotiated from the offer — H.264/VP8) and reads client-created data
  channels in `OnDataChannel`.
- **Single offer/answer exchange over HTTP.** The device *also* trickles ICE
  candidates over a websocket in its cloud path, but the local `/webrtc/session`
  endpoint returns one complete answer. The robust client approach for the local
  path is to **wait for ICE gathering to complete** (or a timeout) before
  POSTing the offer, so the single exchange carries all candidates. `KvmClient`
  does exactly this.

## Data channels (`webrtc.go` `OnDataChannel`)

The **client** creates the data channels; the device switches on `d.Label()`:

| Label | Purpose |
| --- | --- |
| `rpc` | reliable/ordered **JSON-RPC 2.0** — control + state + HID |
| `hidrpc` | binary HID fast-path (newer). We use `rpc` for clarity/stability. |
| `terminal`, `serial`, `cdcacm` | serial/console channels (unused here) |

Video arrives as an **inbound WebRTC media track**, rendered into a `<video>`
element; frames are captured to a canvas and exported as JPEG for the model.

`KvmClient` creates a single `rpc` data channel and a `recvonly` video
transceiver.

## JSON-RPC control methods (`jsonrpc.go` `rpcHandlers`)

Request shape: `{"jsonrpc":"2.0","method":"<m>","params":{...},"id":<n>}`.
Response: `{"jsonrpc":"2.0","result":...,"id":<n>}` or `{...,"error":...}`.

HID (the methods we drive):

| Method | Params | Notes |
| --- | --- | --- |
| `keyboardReport` | `{modifier:uint8, keys:[uint8,...]}` | Full HID report; up to 6 keys. `modifier` is the HID modifier bitmask. |
| `keypressReport` | `{key:uint8, press:bool}` | Single key down/up. |
| `absMouseReport` | `{x:int, y:int, buttons:uint8}` | **x,y ∈ 0..32767** (HID Logical Maximum 0x7FFF in `hid_mouse_absolute.go`). `buttons` bitmask: bit0 left, bit1 right, bit2 middle. |
| `relMouseReport` | `{dx, dy, buttons}` | Relative movement. |
| `wheelReport` | `{wheelY, wheelX}` | Scroll. |

HID modifier bits (standard USB HID): LCtrl `0x01`, LShift `0x02`, LAlt `0x04`,
LGui `0x08`, RCtrl `0x10`, RShift `0x20`, RAlt `0x40`, RGui `0x80`.

State / media / power (used for boot control and ISO mounting):

| Method | Params | Purpose |
| --- | --- | --- |
| `getVideoState` | — | video on/off, resolution. |
| `getUSBState` | — | USB emulation state. |
| `getEDID` / `setEDID` | `{edid}` | monitor EDID. |
| `mountWithHTTP` | `{url, mode}` | Mount an ISO served over HTTP as USB mass storage / CD. |
| `mountWithStorage` | `{filename, mode}` | Mount an ISO already on device storage. |
| `rpcMountBuiltInImage` | `{filename}` | Mount a built-in image. |
| `unmountImage` | — | Unmount. |
| `listStorageFiles` / `getStorageSpace` | — | Storage introspection. |
| `getATXState` / `setATXPowerAction` | `{action}` | ATX power button (extension-gated). |
| `getDCPowerState` / `setDCPowerState` | `{enabled}` | DC power (extension-gated). |
| `reboot` | `{force}` | **Reboots the JetKVM itself, NOT the target host.** Never used for target reboot. |

### Rebooting the *target* (not the JetKVM)

There is no generic "reboot the attached host" RPC — a KVM only has HID + power.
So `KvmBackend` reboots the target by:

1. **Ctrl+Alt+Del** via `keyboardReport` (works from most Windows states,
   including the lock screen and WinRE), or a menu-driven restart; else
2. ATX/DC power action **if** the ATX/DC extension is present
   (`getATXState`/`getDCPowerState` report availability); else
3. prompt the human to press the physical power button (v1 has no ATX board
   assumption).

## Coordinate mapping

Claude's computer-use tool returns coordinates in the *downscaled screenshot*
space (≤1280×800 per the reference agent loop). We:

1. capture the KVM video frame at its native resolution,
2. downscale to the model's screenshot size and remember the scale factor,
3. map the model's `(x, y)` back to native pixels, then
4. map native pixels → the KVM absolute space `0..32767`:
   `absX = round(nativeX / nativeW * 32767)`, likewise for Y.

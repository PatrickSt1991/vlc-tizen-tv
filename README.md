# VLC TV — Tizen Web App

A VLC-style media player for Samsung Smart TVs running Tizen, built as a Web
App (`.wgt`) using Samsung's **AVPlay** API for hardware-accelerated playback.

Plays network streams (HTTP MP4, HLS, MPEG-DASH, RTSP) and local USB files
with VLC-inspired UI and TV remote-friendly navigation.

![icon](res/vlctv.png)

---

## Features

- **Playback** via Samsung AVPlay — hardware-accelerated H.264 / HEVC / VP9,
  AAC / MP3 / AC3 / EAC3 / DTS, HLS / MPEG-DASH / RTSP / RTMP / Smooth-Streaming
- **File browser** for USB drives + built-in storage (Videos, Downloads, etc.)
- **SMB network shares** — browse and stream from SMB2 servers (NAS, Windows,
  Samba) over your LAN; configure under Settings → SMB network share
- **Network stream input** with preset chips for quick testing
- **Cast from any device** — paste a stream URL from your phone, tablet or
  laptop instead of typing on the remote; QR pairing, no companion app, no
  account, and no relay to host
- **Recent history** of last 20 played items
- **VLC-style UI** — dark slate-blue theme matching the cone icon
- **Full TV remote support** — D-pad navigation, OK/BACK, media keys
  (Play/Pause/Stop/FF/RW), audio + subtitle track picker
- **External subtitles** — SRT / VTT / ASS·SSA / SAMI sidecar files and
  embedded MP4/MKV text tracks, painted by the app (AVPlay can't render text
  subs on this firmware), with **customisable size, font, position and
  background** under Settings → Subtitle appearance
- **No native code** — pure HTML/CSS/JS so it runs on any Tizen TV with a
  Public-tier developer cert. No partner-cert or platform-side requirements.

## Tested on

- Samsung UE55RU7020WXXN (2019, Tizen 5.0)
- Samsung S90C (2023, Tizen 6.5) — MKV plays via AVPlay; DTS/TrueHD audio
  tracks can't be decoded by the TV (auto-skipped to a supported track when
  the file has one)
- Should run on any Tizen TV from 2017 onward with AVPlay support. **SMB share
  support requires Tizen 4.0+ (2018 sets onward)** — it relies on a background
  service application that older firmware doesn't run.

> **SMB credentials note:** server credentials you enter under Settings are
> stored unencrypted in the app's local storage on the TV. Prefer a dedicated
> guest/read-only share account over reusing a sensitive password.

## Installation

The recommended path is the [GitHub Releases page](https://github.com/PatrickSt1991/vlc-tizen-tv/releases) — pre-built `.wgt`
files are published there by the build workflow.

### 1. Enable Developer Mode on your TV

1. From the Apps screen, press `1 2 3 4 5` on the remote
2. Toggle **Developer Mode = ON**
3. Enter your PC's LAN IP in **Host PC IP**
4. Reboot the TV

### 2. Install the `.wgt`

#### Install with Apps2Samsung

Download the latest version from [Apps2Samsung](https://github.com/Apps2Samsung/Apps2Samsung/releases/latest) choose Tizen Community as release and choose vlc-tizen-tv.

Launch **VLC TV** from your TV's app list.

#### Install the `.wgt` with Tizen Studio

Download the latest `vlctv.wgt` from Releases. Then sign with your Samsung
distributor cert (the workflow ships a generic cert, but Samsung TVs require
the `.wgt` to be signed by *your* cert tied to your TV's DUID — Tizen Studio's
**Certificate Manager** handles this).

Once signed:

```bash
sdb connect <tv-ip>
sdb install /path/to/vlctv-signed.wgt
```

Launch **VLC TV** from your TV's app list.

## Building from source

The repo's GitHub Actions workflow builds a signed `.wgt` automatically on
every push and `workflow_dispatch`. You can trigger it manually from the
**Actions** tab.

For local builds:

```bash
bash tizen-web-vlc/build.sh
# Output: dist/madebypatk-vlcweb.wgt (unsigned, just zipped)
```

For a signed build identical to the workflow output, use Tizen Studio's
`tizen package -t wgt -s <profile>` after generating a profile in **Certificate
Manager**.

## Streaming URL examples

The home screen has tap-to-fill chips for these:

| Type | URL |
|---|---|
| MP4 (short) | `http://vjs.zencdn.net/v/oceans.mp4` |
| HLS (single bitrate) | `https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8` |
| MP4 (long) | `https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4` |
| HLS (multi-bitrate) | `https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_16x9/bipbop_16x9_variant.m3u8` |
| MPEG-DASH | `https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd` |
| RTSP (public) | `rtsp://170.93.143.139:554/rtplive/470011e600ef003a004ee33696235daa` |

## Cast a link from your phone, tablet or laptop

Typing URLs on a TV remote is painful, so VLC TV lets you paste a stream URL
from another device instead — **no companion app, no account, and no server you
have to run.**

Open **Network Stream → 📲 Get URL from device**, or pair once from
**Settings → Cast from another device** (scan the QR, or enter the short code).
On your phone or laptop, open the pairing page, paste a URL, tap **Send to TV**,
then press **Get URL from device** on the TV — it plays.

### How it works

A Tizen `.wgt` runs in the TV's sandboxed WebView, which can't open a listening
socket — so the TV can never be a server (the same wall that rules out a
VLC-style built-in web interface). Instead the TV is a *client*:

```
 device page  ──POST──▶  ntfy.sh/vlctv-<code>  ◀──GET──  VLC TV
```

The device POSTs the URL to a free public [ntfy.sh](https://ntfy.sh) topic; the
TV pulls the latest message on a button press. Each TV mints a long random
pairing code once, so the topic (`vlctv-<code>`) is private-by-obscurity. The QR
encodes the page URL with the code in the hash, so scanning opens the page
already paired — and the QR is generated **on the TV, offline** (bundled
`qrcode.js`), so the code never touches a third-party QR service.

> **Privacy:** a public topic is readable by anyone who knows the code, which is
> why the code is long and random. Fine for public stream URLs — don't push
> anything secret through it.

### Hosting the pairing page

The pairing page is a single static file (`docs/index.html` + `icon.png`),
served at the URL set in `js/url-drop.js`:

```js
var PHONE_PAGE = 'https://vlc-tizen.madebypatrick.nl/';
```

Host it anywhere static, over **HTTPS** (required — the page POSTs to
`https://ntfy.sh`, so plain HTTP is blocked as mixed content). Own domain or
GitHub Pages both work. To own the rendezvous too, ntfy self-hosts as a single
binary, or flip to the built-in n8n adapter in `url-drop.js`. Details:
[docs/SEND-URL-FROM-DEVICE.md](docs/SEND-URL-FROM-DEVICE.md).

## Architecture

```
tizen-web-vlc/
├── config.xml          Tizen widget manifest (privileges, screen, package id)
├── index.html          Single-page shell — home / url / browse / player views
├── icon.png            App icon (also used as the brand mark)
├── css/
│   └── style.css       Dark slate-blue theme, focus management, OSD
├── js/
│   ├── debug.js        Optional UDP/HTTP-style telemetry to a PC for debugging
│   ├── remote.js       TV remote key registration + dispatch
│   ├── ui.js           Focus management + view switching + toast
│   ├── browser.js      USB / Tizen filesystem enumeration
│   ├── player.js       Samsung AVPlay wrapper (HLS/DASH/RTSP/files)
│   ├── url-drop.js     "Cast from any device" — pulls a URL via ntfy.sh
│   ├── qrcode.js       Offline QR generator (MIT, Kazuhiko Arase) for pairing
│   └── app.js          Top-level coordinator
└── build.sh            Local zip-only builder (no signing)
```

## Why a Web App and not Native?

This project started as a native C/C++ port of `libvlc` for Tizen 5.0 ARM,
fully cross-compiled with `arm-linux-gnueabi-gcc`, GLIBC version-string
patching, and a custom glibc compat shim for y2038 wrappers. It built cleanly,
installed cleanly, but **never launched** on the retail TV — Samsung's
launchpad on retail firmware silently refuses third-party native (`type="capp"`)
binaries from non-partner distributor certs.

Web apps (`.wgt`, `type="webapp"`) launch fine because they run in the TV's
sandboxed WebView. AVPlay covers the same codec breadth that libvlc would have
provided, just through a JS API instead of C. Net result: same user
experience, supported path.

## Acknowledgments

- VLC and the cone icon design language — © VideoLAN
- Samsung Tizen TV AVPlay API docs
- [tizen-jellyfin-avplay](https://github.com/PatrickSt1991/tizen-jellyfin-avplay) — workflow template inspiration

## Support

If VLC TV is useful to you, consider supporting development:

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/M4M71JOT9R)

<img src="tizen-web-vlc/ko-fi-qr.webp" alt="Ko-fi QR" width="180">

## Screenshots
<img width="1457" height="834" alt="Screenshot 2026-06-03 143227" src="https://github.com/user-attachments/assets/5ea3ba2f-f797-44b2-8b72-e4760bca657a" />
<img width="1457" height="834" alt="Screenshot 2026-06-03 143213" src="https://github.com/user-attachments/assets/947c1b3c-8e7b-4d4a-934a-f4c25ea12742" />
<img width="1457" height="834" alt="Screenshot 2026-06-03 143110" src="https://github.com/user-attachments/assets/e13648e0-bcfe-4773-a817-9e5e10ee4629" />
<img width="1457" height="834" alt="Screenshot 2026-06-03 143057" src="https://github.com/user-attachments/assets/a57dd4d1-8761-4101-abf0-c6f93048e9bf" />
<img width="1457" height="834" alt="Screenshot 2026-06-03 143027" src="https://github.com/user-attachments/assets/5fe0422f-08e1-43eb-9c5a-ea855f755558" />
<img width="1457" height="834" alt="Screenshot 2026-06-03 143016" src="https://github.com/user-attachments/assets/3ffc8365-c73a-4eba-b05b-63ed399ef33a" />
<img width="1457" height="834" alt="Screenshot 2026-06-03 143007" src="https://github.com/user-attachments/assets/16e1d60a-8f3d-44de-b419-20e9bc8188ed" />


## License

MIT — see [LICENSE](LICENSE).

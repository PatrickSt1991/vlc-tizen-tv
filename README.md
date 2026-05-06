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
- **Network stream input** with preset chips for quick testing
- **Recent history** of last 20 played items
- **VLC-style UI** — dark slate-blue theme matching the cone icon
- **Full TV remote support** — D-pad navigation, OK/BACK, media keys
  (Play/Pause/Stop/FF/RW), audio + subtitle track picker
- **No native code** — pure HTML/CSS/JS so it runs on any Tizen TV with a
  Public-tier developer cert. No partner-cert or platform-side requirements.

## Tested on

- Samsung UE55RU7020WXXN (2019, Tizen 5.0)
- Should run on any Tizen TV from 2017 onward with AVPlay support

## Installation

The recommended path is the [GitHub Releases page](https://github.com/PatrickSt1991/vlc-tizen-tv/releases) — pre-built `.wgt`
files are published there by the build workflow.

### 1. Enable Developer Mode on your TV

1. From the Apps screen, press `1 2 3 4 5` on the remote
2. Toggle **Developer Mode = ON**
3. Enter your PC's LAN IP in **Host PC IP**
4. Reboot the TV

### 2. Install the `.wgt`

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

## License

MIT — see [LICENSE](LICENSE).

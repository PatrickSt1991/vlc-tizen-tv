# VLC Transcode Server

A tiny self-hosted companion for the [VLC Tizen TV app](../). It runs on a small
always-on box (e.g. an AM6b+), reads your media from an **SMB share**, and
**transcodes only what the TV can't decode** — DTS / TrueHD audio, or an
unsupported video codec — into a TV-friendly **HLS** stream. Files the TV can
already play are remuxed untouched (near-zero CPU).

The TV keeps browsing the share exactly as before; the only thing that changes
is *where the bytes come from* when you press play.

## Why it exists

Samsung Tizen TVs can't decode DTS or TrueHD in-app (a hardware/licensing wall —
even Plex plays those files silent). This box does the decode the TV can't, and
hands the TV an HLS URL it *can* play.

## Run it

You need Docker on the box. The image bundles ffmpeg — nothing else to install,
nothing to clone or build.

**One-liner:**

```bash
docker run -d --name vlc-transcode --restart unless-stopped \
  -p 8200:8200 -v "$PWD/vlc-data:/data" --device /dev/dri \
  ghcr.io/patrickst1991/vlc-transcode:latest
```

**Or with Compose** (grab `docker-compose.yml` from this folder):

```bash
docker compose up -d
```

(`--device /dev/dri` exposes the hardware encoder; it's harmless if the box
doesn't have one — the server falls back to software.)

Then open **`http://<box-ip>:8200`** in any browser and fill in your SMB share
(host, share name, username/password — or toggle Guest). Use **Test connection**
and **Browse share** to confirm it can see your files.

## Run it natively (Windows / macOS / no-Docker Linux)

Docker is the recommended path on a server / NAS / Proxmox box that's going to
stay up. For Windows and macOS — or any machine where installing Docker is more
effort than the transcoder itself — there are static binaries you can run
straight, no container. They're built from the same Go source as the image and
go through the same encoder auto-detection at startup.

**1. Grab the binary** for your platform from the
[Releases page](https://github.com/PatrickSt1991/vlc-tizen-tv/releases),
under the latest `transcode-v*` tag:

| OS | Asset |
|---|---|
| Windows x64 | `vlc-transcode-windows-amd64.zip` |
| macOS Apple Silicon | `vlc-transcode-darwin-arm64.zip` |
| macOS Intel | `vlc-transcode-darwin-amd64.zip` |
| Linux x64 | `vlc-transcode-linux-amd64.zip` |
| Linux ARM64 (Raspberry Pi 4/5, generic ARM) | `vlc-transcode-linux-arm64.zip` |

Unzip anywhere. There's a single executable plus this README.

**2. Install ffmpeg**, because — unlike the Docker image — the bundle doesn't
ship it. Recommended sources:

| OS | Where to get ffmpeg |
|---|---|
| Windows | [gyan.dev "full" build](https://www.gyan.dev/ffmpeg/builds/) or [BtbN "gpl" build](https://github.com/BtbN/FFmpeg-Builds/releases). Either includes `h264_qsv` (Intel), `h264_nvenc` (NVIDIA), and `h264_amf` (AMD). Drop `ffmpeg.exe` and `ffprobe.exe` either on your `PATH` or next to `vlc-transcode.exe`. |
| macOS | `brew install ffmpeg` — Homebrew's build includes `h264_videotoolbox` for native Apple Silicon / Intel HW encoding. |
| Linux | `apt install ffmpeg` or your distro equivalent. Includes VAAPI, NVENC and software encoders. |

**3. Run it.** It listens on `:8200` on all interfaces, so it's reachable
from the TV out of the box. You only need to point it at a writable data
directory (where the config + pairing token live):

```bash
# Linux / macOS
DATA_DIR=./vlc-data ./vlc-transcode

# Windows (cmd.exe / PowerShell)
set DATA_DIR=%CD%\vlc-data
vlc-transcode.exe
```

If you'd rather use a different port, set `PORT=8201` (etc.) in the same
env. The default `/data` is fine inside Docker but won't exist on a native
install — `./vlc-data` next to the binary is the easiest choice.

On first start, the binary prints something like:

```
ffmpeg=/usr/bin/ffmpeg encoder=h264_qsv (qsv)
listening on :8200
```

If it instead exits with `ffmpeg not found — install ffmpeg`, your `ffmpeg`
isn't on `PATH`. Either install it (see the table above) or put `ffmpeg(.exe)`
and `ffprobe(.exe)` in the same folder as `vlc-transcode(.exe)`.

Then open `http://<this-machine's-LAN-IP>:8200` and continue with [Pair with the
TV](#pair-with-the-tv) below.

### Why native sometimes beats Docker

For Windows users specifically, the native binary unlocks GPU encoding that
Docker can't reach:

| GPU | Docker on Windows | Native Windows |
|---|---|---|
| Intel iGPU (QuickSync) | ❌ no path — `--device /dev/dri` doesn't exist on WSL2 | ✅ `h264_qsv` auto-detected |
| NVIDIA | ⚠️ works with Docker Desktop + NVIDIA Container Toolkit + `--gpus all` (fiddly) | ✅ `h264_nvenc` auto-detected |
| AMD | ❌ no path | ✅ `h264_amf` auto-detected |
| None / unsupported | software (`libx264`), slow | software (`libx264`), slow |

On macOS, native always wins — Docker Desktop on macOS runs a Linux VM with no
GPU passthrough, so the container is forced into software encoding; the native
binary uses `h264_videotoolbox` via macOS's hardware encoder.

## Pair with the TV

On the TV: **Settings → Transcode server → Pair**, then enter the code the TV
shows into the **Pair with TV** box on this page. The server publishes its LAN
address + a token to the TV (via the same ntfy pairing channel the app already
uses), and the TV stores it.

From then on the TV browses your SMB share exactly as before — but when you press
play, the file streams through this box, transcoded as needed. Nothing else in
the TV's flow changes; if the server is ever unpaired or offline the TV falls
back to playing directly.

> The server must point at the **same share** the TV browses, so the relative
> paths line up.

## Verify transcoding (before the TV is involved)

The setup page shows a ready-made **Test transcoding** link (it includes the
token). Open it in VLC on a laptop, swapping in a real file path:

```
http://<box-ip>:8200/play?path=/Movies/SomeMovie.mkv&token=<token>
```

The server probes the file, decides remux-vs-transcode, starts ffmpeg, and
serves the live HLS manifest. A DTS/TrueHD file should now play **with sound**.

## How it decides

| Source | Treatment |
|---|---|
| Video + audio both TV-friendly | **Remux only** (copy/copy) |
| Only audio is DTS/TrueHD | Copy video, transcode audio → AC3 (5.1) / AAC (stereo) |
| Video codec unsupported | Hardware-transcode video → H.264, fix audio |

## Hardware acceleration

The encoder is **auto-detected at startup** — it picks the fastest H.264 encoder
ffmpeg reports and falls back to software (`libx264`). Detection order:
`rkmpp → vaapi → nvenc → qsv → v4l2m2m → libx264`.

- **Intel / AMD (VAAPI):** works out of the box if `/dev/dri` is passed in
  (it is, in the compose file).
- **Nvidia / Jetson (NVENC):** needs the NVIDIA container runtime + drivers.
- **Rockchip (rkmpp):** stock Debian ffmpeg has no rkmpp; the server falls back
  to V4L2/software. Swap in an rkmpp-enabled ffmpeg build to enable it.
- Force a specific encoder by setting `"encoder": "libx264"` in
  `data/config.json` if auto-pick misbehaves.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | `8200` | HTTP port |
| `DATA_DIR` | `/data` | where `config.json` is persisted |
| `WORK_DIR` | `/tmp/vlc-transcode` | scratch for HLS segments |

## Known limitations (Phase 1)

- **Seeking** works within the already-transcoded range; jumping far ahead waits
  for the encode to reach that point (seek-restart is a planned improvement).
- **Subtitles** are not muxed into the HLS stream yet (the TV app handles subs
  separately).
- One active stream per file; the box transcodes in real time, so a weak CPU may
  not keep up with software encoding of heavy 4K video.

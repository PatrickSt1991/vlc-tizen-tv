# VLC TV Transcode Server

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
docker run -d --name vlc-tv-transcode --restart unless-stopped \
  -p 8200:8200 -v "$PWD/vlc-data:/data" --device /dev/dri \
  ghcr.io/patrickst1991/vlc-tv-transcode:latest
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

| OS | Asset | Bundled ffmpeg? |
|---|---|---|
| Windows x64 | `vlc-tv-transcode-windows-amd64.zip` | ✅ included (BtbN GPL build) |
| Linux x64 | `vlc-tv-transcode-linux-amd64.zip` | ✅ included (BtbN GPL build) |
| Linux ARM64 (Raspberry Pi 4/5, generic ARM) | `vlc-tv-transcode-linux-arm64.zip` | ✅ included |
| macOS Apple Silicon | `vlc-tv-transcode-darwin-arm64.zip` | ❌ run `brew install ffmpeg` |
| macOS Intel | `vlc-tv-transcode-darwin-amd64.zip` | ❌ run `brew install ffmpeg` |

Unzip anywhere. On Windows + Linux that gets you `vlc-tv-transcode(.exe)` plus
`ffmpeg(.exe)` and `ffprobe(.exe)` in the same folder — the server picks them
up automatically (the binary prepends its own directory to `PATH` at
startup), so there's nothing to install. On macOS, `brew install ffmpeg` once
and it's permanently on `PATH`.

**2. Run it.** It listens on `:8200` on all interfaces, so it's reachable
from the TV out of the box. You only need to point it at a writable data
directory (where the config + pairing token live):

```bash
# Linux / macOS
DATA_DIR=./vlc-data ./vlc-tv-transcode

# Windows (cmd.exe / PowerShell)
set DATA_DIR=%CD%\vlc-data
vlc-tv-transcode.exe
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
and `ffprobe(.exe)` in the same folder as `vlc-tv-transcode(.exe)`.

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

Fill in your SMB share on this page first (host, share, credentials — **Test
connection** to confirm). Then, on the TV:

**Settings → Transcode server → Find server on my network**

That's the whole flow. The TV sweeps its own subnet, finds this box, stores the
pairing, and settles the share settings between the two of you — whichever end
already knows them tells the other:

| Situation | What happens |
|---|---|
| This box has a share configured | The TV copies it down (needs **Let a paired TV copy these settings**, on by default, and the pairing window open — see below) |
| This box is fresh, the TV already had SMB working | The TV sends its settings up here |
| Neither has one | Fill the share in on either end; **Send my share settings to the server** on the TV pushes it up later |

So if your TV already browses your NAS, you can skip this page entirely: install
the box, press *Find server on my network*, done. There is no code to read off
one screen and into another, and nothing leaves your LAN.

From then on the TV browses your share exactly as before; the only change is
that pressing play streams through this box, transcoded as needed. If the server
is ever unpaired or offline the TV falls back to playing directly.

> Because the TV copies the share settings from here, both ends point at the
> **same share** automatically — which is what makes the relative paths line up.
> If you turn credential copying off, make sure they match by hand.

### If the scan finds nothing

The sweep only covers the TV's own subnet, and only when that subnet is /22 or
narrower (a wider one would mean thousands of probes). It also needs the TV and
this box to be able to reach each other — guest Wi-Fi and AP/client isolation
routinely block that.

Two fallbacks, in order of preference:

1. **Enter the address by hand.** On the TV, type this box's address into
   **Settings → Transcode server → Server address** (the Status card above shows
   it) and press **Connect to this address**. Same result as the scan, no
   discovery needed — this also covers the case where the box is on a different
   subnet but still routable.
2. **Pair with a code.** The original method, under *Pair with a code instead*
   on this page. It relays through ntfy.sh, so both ends need working internet,
   and the order matters: enter the TV's code here and press **Pair** *before*
   pressing **Pair with a code** on the TV.

### The pairing window

The share **password** is the one genuinely sensitive thing this box holds, so
it isn't simply on offer to anything that asks. `/api/adopt` only answers during
a ten-minute window, which opens when:

- the box starts,
- you save the share on this page, or
- you press **Allow pairing for 10 minutes**.

Every legitimate flow happens inside one of those — you pair the TV minutes
after installing the box or setting the share up. Outside the window the
password isn't handed out at all, token or no token. If a TV pairs late, the
setup page tells you the window is closed; press the button and use **Settings →
Transcode server → Get share settings from the server** on the TV.

Already-paired TVs are unaffected: they stored the settings when they paired and
never ask again.

> Why a window rather than "only the first TV to pair gets in"? Because the
> setup page needs the pairing token for every write it makes — including the
> button that would let a second device in. Locking the token to one device
> bricks the page and leaves no way back except editing `config.json` by hand. A
> window has no such dead end.

### What's exposed on your LAN

Worth being explicit, because the scan-based flow makes it visible: **this box
treats your LAN as trusted.**

Every `/api` endpoint except `/api/hello` and `/api/status` requires the pairing
token — but `/api/status` is exactly where a TV reads that token from, so
anything on your network can read it too. The token check stops accidents
(another tool poking a URL it found, a stray script, a forgotten browser tab),
not a determined device on your network. That is why the password sits behind
the window as well as behind the token, and why you can switch credential
copying off entirely.

Being able to *play* your own media over your own LAN is the risk the token
covers, and that's the posture the box has always had. Nothing here is reachable
from outside your network unless you deliberately forward the port — don't.

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
| Multichannel audio, surround on | Copy video, transcode audio → E-AC-3 / AC-3 5.1 |

## Surround sound (5.1 to a soundbar)

A 5.1 FLAC, AAC or PCM track plays on the TV and still arrives at the soundbar
as **stereo**. That isn't the TV app downmixing — it's the link. HDMI-ARC and
optical carry either LPCM or an IEC 61937-framed bitstream, and only Dolby
Digital and Dolby Digital Plus have that framing. Everything else the TV decodes
itself, and plain ARC can only carry two channels of the resulting LPCM. FLAC in
particular has no bitstream form at all, on any device — an external player that
"sends FLAC 5.1 to the soundbar" is really decoding it and sending multichannel
LPCM over a link that can carry it.

Nothing in a Tizen app can change that: AVPlay has no channel-layout or
passthrough control. What *can* change it is re-encoding upstream, here, into a
format the TV will pass straight through.

Set it on the TV, under **Settings → Transcode server → Surround sound** — the
setting lives on this box but you change it from the sofa, which is where you
are when you notice the soundbar is doing stereo. This page shows the current
value under *Playback*.

| Setting | What happens |
|---|---|
| **Off** (default) | Only audio the TV can't decode is touched. 5.1 FLAC/AAC still reaches the soundbar as stereo. |
| **Dolby Digital Plus 5.1** | Any multichannel track that isn't already AC-3/E-AC-3 is re-encoded to E-AC-3 at 768 kbps. Best quality; needs a DD+ capable soundbar. |
| **Dolby Digital 5.1** | Same, targeting AC-3 at 640 kbps. Use this if your receiver won't take DD+. |

Tracks that are *already* AC-3 or E-AC-3 are copied untouched either way, and
stereo sources are never re-encoded just because the setting is on.

Two things worth knowing:

- This is a lossy re-encode. A lossless FLAC 5.1 track becomes Dolby 5.1 — you
  keep the channels, not the bit-exactness. There is no route that keeps both;
  the TV cannot pass lossless multichannel to a soundbar.
- Set your TV's **Sound → Expert Settings → Digital Output Audio Format** to
  *Pass-through* (or Auto), or it will decode the Dolby stream and downmix it
  again on the way out.

## USB and internal-storage files

Files on a USB stick are physically at the TV, so this box can't read them the
way it reads the share — which is why they used to miss out on both the
surround handling and the unsupported-codec handling.

Turn on **Settings → Transcode server → Play USB files through the server** on
the TV and the direction reverses for those files: the TV app's background
service opens a small read-only listener on your LAN, and hands this box a URL
pointing at it. The box fetches, transcodes, and streams HLS back exactly as it
does for share files.

The TV asks this box for permission as part of that switch, so there's nothing to
do here — the *Allow the TV to send USB / internal files* toggle on this page is
how you **revoke** it. It's off until a TV turns it on. The TV's listener is
armed only while the app is running, only serves paths under the drives
`tizen.filesystem` itself reported, and requires a random per-TV key that the
box receives in the URL. On this side, a `src=` URL is only accepted from a
paired TV, and only when it names a private LAN address — the pairing token
can't be used to make the box fetch from somewhere else.

If either side is off, USB files simply play the way they always did.

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
| `WORK_DIR` | `/tmp/vlc-tv-transcode` | scratch for HLS segments |

## Known limitations (Phase 1)

- **Seeking** works within the already-transcoded range; jumping far ahead waits
  for the encode to reach that point (seek-restart is a planned improvement).
- **Subtitles** are not muxed into the HLS stream yet (the TV app handles subs
  separately).
- One active stream per file; the box transcodes in real time, so a weak CPU may
  not keep up with software encoding of heavy 4K video.
- Surround targets 5.1. A 7.1 source is folded down to 5.1 (both AC-3 and E-AC-3
  encoders top out there), and lossless formats stay lossy after the re-encode.
- USB relay needs the TV app to be open — it's the app's background service that
  serves the file, so the box can't pull from a TV sitting in standby.

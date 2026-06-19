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

You need Docker on the box. The image bundles ffmpeg — nothing else to install.

```bash
git clone https://github.com/PatrickSt1991/vlc-tizen-tv.git
cd vlc-tizen-tv/vlc-transcode-server
docker compose up -d
```

Then open **`http://<box-ip>:8200`** in any browser and fill in your SMB share
(host, share name, username/password — or toggle Guest). Use **Test connection**
and **Browse share** to confirm it can see your files.

That's the whole setup. (Pairing with the TV app comes in a later step; for now
you can verify transcoding directly — see below.)

## Verify transcoding (before the TV is involved)

Point VLC on a laptop at a file via the server:

```
http://<box-ip>:8200/play?path=/Movies/SomeMovie.mkv
```

The server probes the file, decides remux-vs-transcode, starts ffmpeg, and
redirects to the HLS playlist. A DTS/TrueHD file should now play **with sound**.

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

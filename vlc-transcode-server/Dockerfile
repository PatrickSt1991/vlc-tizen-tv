# ── build stage ──────────────────────────────────────────────────────────────
# Pure-Go (go-smb2 needs no cgo), so we cross-compile a fully static binary for
# the target arch on the native build arch — no QEMU emulation for the Go step,
# which keeps multi-arch builds fast.
FROM --platform=$BUILDPLATFORM golang:1.23-bookworm AS build
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags="-s -w" -o /vlc-transcode .

# ── runtime stage ────────────────────────────────────────────────────────────
# Debian's ffmpeg covers software (libx264), VAAPI (Intel/AMD), V4L2 M2M and
# NVENC (with host drivers). Rockchip rkmpp needs a custom ffmpeg build; on those
# boxes auto-detect simply falls back to V4L2/software — see README.
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg \
      mesa-va-drivers \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /vlc-transcode /usr/local/bin/vlc-transcode

ENV DATA_DIR=/data \
    WORK_DIR=/tmp/vlc-transcode \
    PORT=8200
VOLUME /data
EXPOSE 8200

ENTRYPOINT ["/usr/local/bin/vlc-transcode"]

// vlc-transcode-server — a tiny self-hosted companion for the VLC Tizen TV app.
//
// It reads media from your SMB share, transcodes only what the TV can't decode
// (DTS/TrueHD audio, unsupported video) into a TV-friendly HLS stream, and hands
// the TV a URL to play. Everything is configured from an embedded web page, and
// the ffmpeg encoder is auto-detected at startup so the same build runs on a
// Rockchip board, an Intel mini-PC, a Pi, or a plain VM.
package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/PatrickSt1991/vlc-tizen-tv/vlc-transcode-server/internal/config"
	"github.com/PatrickSt1991/vlc-tizen-tv/vlc-transcode-server/internal/smb"
	"github.com/PatrickSt1991/vlc-tizen-tv/vlc-transcode-server/internal/transcode"
	"github.com/PatrickSt1991/vlc-tizen-tv/vlc-transcode-server/internal/web"
)

func main() {
	log.SetFlags(log.LstdFlags)

	port := envInt("PORT", 8200)
	dataDir := envStr("DATA_DIR", "/data")
	workDir := envStr("WORK_DIR", filepath.Join(os.TempDir(), "vlc-transcode"))

	// Config (web-editable; created on first save).
	cfg, err := config.Load(filepath.Join(dataDir, "config.json"))
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	// Auto-detect ffmpeg + the best available H.264 encoder.
	caps, err := transcode.Probe(cfg.Encoder)
	if err != nil {
		log.Fatalf("ffmpeg not found — install ffmpeg (the Docker image bundles it): %v", err)
	}
	log.Printf("ffmpeg=%s encoder=%s (%s)", caps.FFmpeg, caps.VideoEncoder, caps.HWAccel)

	smbClient := smb.New(&cfg.SMB)

	// The manager needs to know how to build the localhost raw-bridge URL, which
	// lives in the web layer — wire it after constructing the server.
	srv := web.New(cfg, smbClient, nil, port)
	mgr, err := transcode.NewManager(caps, workDir, srv.RawURL)
	if err != nil {
		log.Fatalf("manager: %v", err)
	}
	srv.SetManager(mgr)

	addr := fmt.Sprintf(":%d", port)
	httpSrv := &http.Server{
		Addr:              addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	if cfg.Configured() {
		log.Printf("SMB target: %s/%s", cfg.SMB.Host, cfg.SMB.Share)
	} else {
		log.Printf("not configured yet — open http://<this-box>%s to set your SMB share", addr)
	}
	log.Printf("listening on %s", addr)
	if err := httpSrv.ListenAndServe(); err != nil {
		log.Fatalf("http: %v", err)
	}
}

func envStr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envInt(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		var n int
		if _, err := fmt.Sscanf(v, "%d", &n); err == nil {
			return n
		}
	}
	return def
}

package transcode

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"
)

// A session is one running ffmpeg producing an HLS stream for one source file.
// Segments land in Dir; index.m3u8 is the playlist AVPlay loads.
type session struct {
	ID       string
	SrcPath  string // SMB-relative path, for logs
	Dir      string
	Plan     Plan
	cmd      *exec.Cmd
	cancel   context.CancelFunc
	logTail  *ring

	mu         sync.Mutex
	lastAccess time.Time
	done       bool
	exitErr    error
}

// Touch records activity so the idle reaper leaves the session alive.
func (s *session) Touch() {
	s.mu.Lock()
	s.lastAccess = nowFn()
	s.mu.Unlock()
}

// playlistPath / firstSegmentReady let /play know when it's safe to redirect.
func (s *session) playlistPath() string { return filepath.Join(s.Dir, "index.m3u8") }

func (s *session) ready() bool {
	if !fileExists(s.playlistPath()) {
		return false
	}
	segs, _ := filepath.Glob(filepath.Join(s.Dir, "seg*.ts"))
	return len(segs) > 0
}

// stop kills ffmpeg and removes the working directory.
func (s *session) stop() {
	if s.cancel != nil {
		s.cancel()
	}
	if s.Dir != "" {
		os.RemoveAll(s.Dir)
	}
}

// buildArgs assembles the ffmpeg command line from the box's capabilities and
// the per-file plan. Software decode + (optional) hardware encode keeps the
// device handling simple while still offloading the expensive encode step.
func (c *Caps) buildArgs(in string, p Plan, dir string) []string {
	a := []string{"-hide_banner", "-loglevel", "warning", "-y"}

	// Robustness on the internal HTTP raw bridge.
	a = append(a, "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "2")

	// VAAPI needs its device declared before the input.
	if !p.CopyVideo && c.HWAccel == "vaapi" && c.VAAPIDevice != "" {
		a = append(a, "-vaapi_device", c.VAAPIDevice)
	}

	a = append(a, "-i", in)

	// One video + one audio track; subtitles are handled by the app, not muxed.
	a = append(a, "-map", "0:v:0?", "-map", "0:a:0?", "-sn")

	// ── video ──────────────────────────────────────────────────────────
	if p.CopyVideo {
		a = append(a, "-c:v", "copy")
	} else {
		a = append(a, c.videoEncodeArgs()...)
	}

	// ── audio ──────────────────────────────────────────────────────────
	if p.CopyAudio {
		a = append(a, "-c:a", "copy")
	} else if p.AudioEnc == "ac3" {
		ch := p.mi.AudioChans
		if ch == 0 || ch > 6 {
			ch = 6 // AC-3 tops out at 5.1
		}
		a = append(a, "-c:a", "ac3", "-b:a", "640k", "-ac", fmt.Sprintf("%d", ch))
	} else { // aac
		a = append(a, "-c:a", "aac", "-b:a", "256k")
	}

	// ── HLS muxer: growing ("event") VOD playlist, keep every segment so the
	// user can seek back across the whole transcoded range. ENDLIST is written
	// when ffmpeg finishes. ────────────────────────────────────────────────
	a = append(a,
		"-f", "hls",
		"-hls_time", "4",
		"-hls_list_size", "0",
		"-hls_flags", "independent_segments+append_list",
		"-hls_playlist_type", "event",
		"-hls_segment_type", "mpegts",
		"-hls_segment_filename", filepath.Join(dir, "seg%05d.ts"),
		"-start_number", "0",
		filepath.Join(dir, "index.m3u8"),
	)
	return a
}

func (c *Caps) videoEncodeArgs() []string {
	switch c.HWAccel {
	case "vaapi":
		return []string{"-vf", "format=nv12,hwupload", "-c:v", "h264_vaapi", "-b:v", "8M", "-maxrate", "10M"}
	case "nvenc":
		return []string{"-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "21", "-pix_fmt", "yuv420p"}
	case "qsv":
		return []string{"-c:v", "h264_qsv", "-global_quality", "21", "-pix_fmt", "nv12"}
	case "rkmpp":
		return []string{"-c:v", "h264_rkmpp", "-b:v", "8M", "-pix_fmt", "yuv420p"}
	case "v4l2m2m":
		return []string{"-c:v", "h264_v4l2m2m", "-b:v", "8M", "-pix_fmt", "yuv420p"}
	default: // software
		return []string{"-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p"}
	}
}

// idFor derives a stable session id from the source path.
func idFor(path string) string {
	h := sha1.Sum([]byte(path))
	return hex.EncodeToString(h[:])[:16]
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

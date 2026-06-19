// Package web is the HTTP surface: the internal raw-file bridge ffmpeg reads,
// the /play + /hls endpoints AVPlay consumes, and the JSON API behind the
// point-and-click setup page.
package web

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/PatrickSt1991/vlc-tizen-tv/vlc-transcode-server/internal/config"
	"github.com/PatrickSt1991/vlc-tizen-tv/vlc-transcode-server/internal/smb"
	"github.com/PatrickSt1991/vlc-tizen-tv/vlc-transcode-server/internal/transcode"
)

//go:embed static/*
var staticFS embed.FS

// Server bundles the dependencies the handlers need.
type Server struct {
	cfg  *config.Config
	smb  *smb.Client
	mgr  *transcode.Manager
	port int
}

// New constructs the HTTP server glue. The manager is wired afterwards via
// SetManager because it needs this server's RawURL builder at construction.
func New(cfg *config.Config, smbc *smb.Client, mgr *transcode.Manager, port int) *Server {
	return &Server{cfg: cfg, smb: smbc, mgr: mgr, port: port}
}

// SetManager injects the transcode manager once it has been built.
func (s *Server) SetManager(mgr *transcode.Manager) { s.mgr = mgr }

// RawURL is the transcode.RawURLFunc: where ffmpeg reads an SMB file from.
// 127.0.0.1 keeps the bridge off the LAN — only our own ffmpeg uses it.
func (s *Server) RawURL(smbPath string) string {
	return fmt.Sprintf("http://127.0.0.1:%d/raw?path=%s", s.port, urlEscape(smbPath))
}

// Handler builds the routed mux.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	// Setup UI (embedded).
	sub, _ := fs.Sub(staticFS, "static")
	mux.Handle("/", http.FileServer(http.FS(sub)))

	// JSON API for the setup page.
	mux.HandleFunc("/api/config", s.handleConfig)
	mux.HandleFunc("/api/test", s.handleTest)
	mux.HandleFunc("/api/browse", s.handleBrowse)
	mux.HandleFunc("/api/status", s.handleStatus)

	// Media plane.
	mux.HandleFunc("/raw", s.handleRaw)   // ffmpeg input (localhost only)
	mux.HandleFunc("/play", s.handlePlay) // TV entry point → 302 to playlist
	mux.HandleFunc("/hls/", s.handleHLS)  // playlist + segments

	return cors(mux)
}

// ── media plane ─────────────────────────────────────────────────────────────

// handleRaw streams an SMB file with Range support so ffmpeg can seek it.
func (s *Server) handleRaw(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Query().Get("path")
	if p == "" {
		http.Error(w, "missing path", http.StatusBadRequest)
		return
	}
	f, err := s.smb.Open(p)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer f.Close()
	// http.ServeContent handles Range, If-Range, and content-type sniffing using
	// the seekable SMB handle.
	http.ServeContent(w, r, filepath.Base(p), time.Time{}, f.File)
}

// handlePlay ensures a transcode session exists, then redirects the player to
// its HLS playlist. This is the URL the TV ultimately hands to AVPlay.
func (s *Server) handlePlay(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Query().Get("path")
	if p == "" {
		http.Error(w, "missing path", http.StatusBadRequest)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 35*time.Second)
	defer cancel()

	sess, err := s.mgr.EnsureSession(ctx, p)
	if err != nil {
		log.Printf("play %q failed: %v", p, err)
		http.Error(w, "transcode failed: "+err.Error(), http.StatusBadGateway)
		return
	}
	http.Redirect(w, r, "/hls/"+sess.ID+"/index.m3u8", http.StatusFound)
}

// handleHLS serves the playlist and segments from a session's working dir.
func (s *Server) handleHLS(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/hls/")
	parts := strings.SplitN(rest, "/", 2)
	if len(parts) != 2 || parts[1] == "" {
		http.NotFound(w, r)
		return
	}
	id, name := parts[0], parts[1]
	if strings.Contains(name, "..") || strings.ContainsAny(name, "/\\") {
		http.Error(w, "bad name", http.StatusBadRequest)
		return
	}
	sess, ok := s.mgr.Session(id)
	if !ok {
		http.Error(w, "no such session", http.StatusNotFound)
		return
	}
	sess.Touch() // each playlist/segment fetch keeps the session alive

	if strings.HasSuffix(name, ".m3u8") {
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
	} else if strings.HasSuffix(name, ".ts") {
		w.Header().Set("Content-Type", "video/mp2t")
	}
	http.ServeFile(w, r, filepath.Join(sess.Dir, name))
}

// ── setup API ────────────────────────────────────────────────────────────────

func (s *Server) handleConfig(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, s.cfg.Redacted())
	case http.MethodPost:
		var in config.SMB
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		// An empty password on save means "keep the stored one" so the masked
		// form round-trips without wiping credentials.
		if in.Pass == "" {
			in.Pass = s.cfg.SMB.Pass
		}
		if in.Port == 0 {
			in.Port = 445
		}
		s.cfg.SMB = in
		if err := s.cfg.Save(); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, map[string]bool{"ok": true})
	default:
		http.Error(w, "method", http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleTest(w http.ResponseWriter, r *http.Request) {
	if err := s.smb.Probe(); err != nil {
		writeJSON(w, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) handleBrowse(w http.ResponseWriter, r *http.Request) {
	entries, err := s.smb.List(r.URL.Query().Get("path"))
	if err != nil {
		writeJSON(w, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, map[string]any{"ok": true, "entries": entries})
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	caps := s.mgr.Caps()
	writeJSON(w, map[string]any{
		"configured": s.cfg.Configured(),
		"encoder":    caps.VideoEncoder,
		"hwaccel":    caps.HWAccel,
		"share":      s.cfg.SMB.Host + "/" + s.cfg.SMB.Share,
	})
}

// ── helpers ──────────────────────────────────────────────────────────────────

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

// cors lets the Tizen WebView (origin null / file://) call the API and media
// endpoints without preflight friction. The server only exposes read access to
// the configured share, so permissive CORS is acceptable on a LAN appliance.
func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func urlEscape(s string) string {
	// Minimal query escaping; path values rarely contain reserved chars but be safe.
	r := strings.NewReplacer(" ", "%20", "?", "%3F", "#", "%23", "&", "%26", "+", "%2B")
	return r.Replace(s)
}

// for the status page formatting of durations if needed later.
var _ = strconv.Itoa

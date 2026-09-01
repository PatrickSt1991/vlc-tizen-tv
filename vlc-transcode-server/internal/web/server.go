// Package web is the HTTP surface: the internal raw-file bridge ffmpeg reads,
// the /play + /hls endpoints AVPlay consumes, and the JSON API behind the
// point-and-click setup page.
package web

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/PatrickSt1991/vlc-tizen-tv/vlc-transcode-server/internal/config"
	"github.com/PatrickSt1991/vlc-tizen-tv/vlc-transcode-server/internal/pair"
	"github.com/PatrickSt1991/vlc-tizen-tv/vlc-transcode-server/internal/smb"
	"github.com/PatrickSt1991/vlc-tizen-tv/vlc-transcode-server/internal/transcode"
)

//go:embed static/*
var staticFS embed.FS

// adoptWindow is how long the box stays willing to hand its SMB password to a
// pairing TV.
//
// The token that guards /api/adopt is readable from /api/status by anything on
// the LAN, so on its own it doesn't keep the share password out of anyone's
// hands. Locking the token down instead (first device to pair keeps it) breaks
// the setup page, which needs that same token for every write — including the
// button that would let another device in. A time window has neither problem:
// the legitimate flows all happen within minutes of a setup action, and after
// that the password simply isn't on offer any more, token or not.
const adoptWindow = 10 * time.Minute

// Server bundles the dependencies the handlers need.
type Server struct {
	cfg  *config.Config
	smb  *smb.Client
	mgr  *transcode.Manager
	port int

	mu         sync.Mutex
	adoptUntil time.Time // credentials are on offer until this moment
}

// New constructs the HTTP server glue. The manager is wired afterwards via
// SetManager because it needs this server's RawURL builder at construction.
//
// The adopt window starts open: a box that has just been started is a box
// someone is setting up, and that's the moment the TV pairs.
func New(cfg *config.Config, smbc *smb.Client, mgr *transcode.Manager, port int) *Server {
	return &Server{cfg: cfg, smb: smbc, mgr: mgr, port: port, adoptUntil: time.Now().Add(adoptWindow)}
}

// openAdoptWindow (re)starts the window. Called on the events that mean "a human
// is setting this up right now": startup, saving the share, and the explicit
// button on the setup page.
func (s *Server) openAdoptWindow() {
	s.mu.Lock()
	s.adoptUntil = time.Now().Add(adoptWindow)
	s.mu.Unlock()
}

// adoptSecondsLeft is 0 once the window has closed.
func (s *Server) adoptSecondsLeft() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	d := time.Until(s.adoptUntil)
	if d <= 0 {
		return 0
	}
	return int(d.Seconds())
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
	mux.HandleFunc("/api/pair", s.handlePair)
	mux.HandleFunc("/api/hello", s.handleHello) // LAN discovery probe
	mux.HandleFunc("/api/adopt", s.handleAdopt) // hand the share settings to a paired TV
	mux.HandleFunc("/api/allow-adopt", s.handleAllowAdopt)

	// Media plane.
	mux.HandleFunc("/raw", s.handleRaw)   // ffmpeg input (localhost only)
	mux.HandleFunc("/play", s.handlePlay) // TV entry point → 302 to playlist
	mux.HandleFunc("/hls/", s.handleHLS)  // playlist + segments

	return cors(mux)
}

// ── media plane ─────────────────────────────────────────────────────────────

// handleRaw streams an SMB file with Range support so ffmpeg can seek it.
//
// RawURL only ever builds a 127.0.0.1 address, but "we only call it from
// localhost" isn't the same as "only localhost can call it" — the handler is on
// the same LAN-facing mux as everything else, and without this check it would
// serve any file on the share to anyone who guessed the path, no token needed.
// Enforce what the URL builder assumes.
func (s *Server) handleRaw(w http.ResponseWriter, r *http.Request) {
	if !isLoopback(r.RemoteAddr) {
		http.Error(w, "this endpoint is internal to the server", http.StatusForbidden)
		return
	}
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

// handlePlay is the URL the TV hands to AVPlay. It ensures a transcode session,
// then serves that session's live HLS manifest *directly* (rewriting segment
// names to absolute /hls/<id>/ paths). Serving the manifest here — rather than
// 302-redirecting — means we don't depend on AVPlay following redirects, and
// AVPlay's periodic manifest re-fetch (live/event playlist) simply re-hits this
// handler, which returns the current segment list as ffmpeg extends it.
func (s *Server) handlePlay(w http.ResponseWriter, r *http.Request) {
	if !s.checkToken(r) {
		http.Error(w, "unauthorized — pair the TV first", http.StatusForbidden)
		return
	}
	src, err := s.sourceFor(r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 35*time.Second)
	defer cancel()

	sess, err := s.mgr.EnsureSession(ctx, src)
	if err != nil {
		log.Printf("play %q failed: %v", src.Label(), err)
		http.Error(w, "transcode failed: "+err.Error(), http.StatusBadGateway)
		return
	}

	raw, err := os.ReadFile(filepath.Join(sess.Dir, "index.m3u8"))
	if err != nil {
		http.Error(w, "playlist not ready", http.StatusBadGateway)
		return
	}
	w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
	w.Header().Set("Cache-Control", "no-cache")
	w.Write(rewriteManifest(raw, "/hls/"+sess.ID+"/"))
}

// isLoopback reports whether a net/http RemoteAddr is the machine itself.
func isLoopback(remoteAddr string) bool {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// sourceFor turns the /play query into the thing ffmpeg should read.
//
//	?path=Movies/x.mkv   a file on the configured SMB share (the original mode)
//	?src=http://<tv>/…   a file the TV is serving us — its USB drive or internal
//	                     storage, relayed by the app's background service
//
// The src form only exists so USB files get the same treatment as share files.
// It's off unless the user enables it, and the URL is validated below.
func (s *Server) sourceFor(r *http.Request) (transcode.Source, error) {
	q := r.URL.Query()
	if raw := q.Get("src"); raw != "" {
		if !s.cfg.LocalRelay {
			return transcode.Source{}, errors.New("local relay is disabled — enable it on the server's setup page")
		}
		if err := validateRelayURL(raw); err != nil {
			return transcode.Source{}, err
		}
		return transcode.HTTPSource(raw), nil
	}
	if p := q.Get("path"); p != "" {
		return transcode.SMBSource(p), nil
	}
	return transcode.Source{}, errors.New("missing path")
}

// validateRelayURL keeps the src parameter from turning the pairing token into a
// general-purpose fetch primitive. A paired TV is trusted to say "here is a file
// on me", not to make the box read its own admin API or wander off the LAN, so
// we require plain HTTP(S) to a literal IP address that is private and not
// loopback. Refusing hostnames as well as public IPs means there's no DNS
// rebinding step to worry about either.
func validateRelayURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("bad src URL: %w", err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return errors.New("src must be http or https")
	}
	ip := net.ParseIP(u.Hostname())
	if ip == nil {
		return errors.New("src must address the TV by IP, not by name")
	}
	if ip.IsLoopback() || ip.IsUnspecified() {
		return errors.New("src must not point back at this server")
	}
	if !ip.IsPrivate() && !ip.IsLinkLocalUnicast() {
		return errors.New("src must be a LAN address")
	}
	return nil
}

// rewriteManifest prefixes bare segment filenames with the absolute HLS path so
// they resolve regardless of the manifest's own URL.
func rewriteManifest(m3u8 []byte, prefix string) []byte {
	lines := strings.Split(string(m3u8), "\n")
	for i, ln := range lines {
		t := strings.TrimSpace(ln)
		if t == "" || strings.HasPrefix(t, "#") {
			continue // comment/tag or blank — leave untouched
		}
		lines[i] = prefix + t // a segment (or sub-playlist) reference
	}
	return []byte(strings.Join(lines, "\n"))
}

// checkToken enforces the pairing secret. A request is allowed when no token is
// configured (shouldn't happen — EnsureToken runs at startup) or the supplied
// token matches.
func (s *Server) checkToken(r *http.Request) bool {
	want := s.cfg.Token
	return want == "" || r.URL.Query().Get("token") == want
}

// guard is checkToken plus the 403, for the handlers that all reject the same
// way. Everything under /api needs it except /api/hello and /api/status, which
// are what a TV uses to find us and to learn the token in the first place.
//
// Worth being clear about what this is and isn't: since /api/status hands the
// token to anything on the LAN, this is not an authentication boundary. It
// stops accidents — another tool on the network poking a URL it found, a stray
// script, a browser tab left open on someone else's machine — from rewriting
// your share config. A hostile device on your LAN can still read the token and
// walk straight through. Treat the LAN as the real boundary.
func (s *Server) guard(w http.ResponseWriter, r *http.Request) bool {
	if s.checkToken(r) {
		return true
	}
	http.Error(w, "unauthorized — this endpoint needs the pairing token", http.StatusForbidden)
	return false
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

// smbFields are the flat keys the setup page has always posted. Their presence
// in the body is what tells handleConfig that the caller means to set the share
// — see the partial-update note there.
var smbFields = []string{"host", "port", "share", "user", "pass", "domain", "anonymous"}

func (s *Server) handleConfig(w http.ResponseWriter, r *http.Request) {
	if !s.guard(w, r) {
		return
	}
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, s.cfg.Redacted())
	case http.MethodPost:
		// Partial updates matter here: the TV sets surround without knowing or
		// caring about the share, and the setup page saves the share without
		// touching playback. Decoding into a struct alone can't tell "absent"
		// from "zero", so an absent share block would silently wipe a working
		// one. Look at which keys the body actually carries, and only apply
		// those. The playback options use pointers for the same reason.
		body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		if err != nil {
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}
		var present map[string]json.RawMessage
		if err := json.Unmarshal(body, &present); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		// The SMB fields are inlined (the form has always posted them flat);
		// the playback options are pointers so a client that doesn't know
		// about them can't reset them by omission.
		var in struct {
			config.SMB
			Surround         *string `json:"surround"`
			LocalRelay       *bool   `json:"local_relay"`
			ShareCredentials *bool   `json:"share_credentials"`
		}
		if err := json.Unmarshal(body, &in); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}
		hasSMB := false
		for _, k := range smbFields {
			if _, ok := present[k]; ok {
				hasSMB = true
				break
			}
		}
		if hasSMB {
			// An empty password on save means "keep the stored one" so the
			// masked form round-trips without wiping credentials.
			if in.Pass == "" {
				in.Pass = s.cfg.SMB.Pass
			}
			if in.Port == 0 {
				in.Port = 445
			}
			s.cfg.SMB = in.SMB
		}
		if in.Surround != nil {
			s.cfg.Surround = transcode.NormaliseSurround(*in.Surround)
		}
		if in.LocalRelay != nil {
			s.cfg.LocalRelay = *in.LocalRelay
		}
		if in.ShareCredentials != nil {
			s.cfg.ShareCredentials = in.ShareCredentials
		}
		if err := s.cfg.Save(); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		// Setting the share up is itself a setup action — otherwise a box that
		// has been running for a week, whose share you only just configured,
		// would refuse to hand it to the TV you're about to pair.
		if hasSMB && s.cfg.Configured() {
			s.openAdoptWindow()
		}
		writeJSON(w, map[string]bool{"ok": true})
	default:
		http.Error(w, "method", http.StatusMethodNotAllowed)
	}
}

func (s *Server) handleTest(w http.ResponseWriter, r *http.Request) {
	if !s.guard(w, r) {
		return
	}
	if err := s.smb.Probe(); err != nil {
		writeJSON(w, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func (s *Server) handleBrowse(w http.ResponseWriter, r *http.Request) {
	if !s.guard(w, r) {
		return
	}
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
		"app":        AppID,
		"configured": s.cfg.Configured(),
		"encoder":    caps.VideoEncoder,
		"hwaccel":    caps.HWAccel,
		"share":      s.cfg.SMB.Host + "/" + s.cfg.SMB.Share,
		"surround":   transcode.NormaliseSurround(s.cfg.Surround),
		"localRelay": s.cfg.LocalRelay,
		"canAdopt":   s.cfg.CanShareCredentials(),
		"adoptLeft":  s.adoptSecondsLeft(),
		"token":      s.cfg.Token, // LAN-trusted UI; used to build the test link
		"serverURL":  pair.LocalURL(s.port),
		"lastPair":   s.cfg.LastPair, // nil until the first successful pair publish
	})
}

// AppID is what a LAN scan looks for. The TV sweeps its own subnet for anything
// answering on the server port, and needs one unambiguous "yes, that's me"
// before it offers to pair — a bare 200 from some other service on 8200 isn't
// good enough.
const AppID = "vlc-tv-transcode"

// APIVersion lets a future TV app tell an old server from a new one without
// probing endpoint by endpoint. Bump it when the pairing contract changes.
const APIVersion = 1

// handleHello is the discovery probe: unauthenticated, cheap, and carrying no
// secrets — just enough for a scanning TV to recognise us and show a name.
// The token deliberately isn't here; that stays on /api/status.
func (s *Server) handleHello(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]any{
		"app":        AppID,
		"api":        APIVersion,
		"name":       pair.Hostname(),
		"port":       s.port,
		"configured": s.cfg.Configured(),
		"canAdopt":   s.cfg.CanShareCredentials() && s.cfg.Configured(),
	})
}

// handleAdopt hands the SMB settings — password included — to a TV that already
// holds the pairing token, so the share is typed once here rather than six
// fields at a time on a remote.
//
// The honest trust model: the token is readable from /api/status by anything on
// the LAN, so this is "the LAN is trusted", not "this is authenticated". That's
// the posture the box has always had, and the TV stores the same credentials
// unencrypted anyway — but it's a deliberate widening, so it's a setting the
// user can turn off.
func (s *Server) handleAdopt(w http.ResponseWriter, r *http.Request) {
	if !s.guard(w, r) {
		return
	}
	if !s.cfg.CanShareCredentials() {
		writeJSON(w, map[string]any{"ok": false, "error": "the server is set not to share its share settings"})
		return
	}
	if !s.cfg.Configured() {
		writeJSON(w, map[string]any{"ok": false, "error": "no share configured on the server yet"})
		return
	}
	if s.adoptSecondsLeft() == 0 {
		writeJSON(w, map[string]any{"ok": false, "error": "the pairing window has closed — press \"Allow pairing\" on the server's setup page, or restart the box, then try again"})
		return
	}
	writeJSON(w, map[string]any{"ok": true, "smb": s.cfg.SMB})
}

// handleAllowAdopt reopens the window from the setup page. Token-gated like
// every other write — and reachable, because the page reads that token off
// /api/status, which the window never touches.
func (s *Server) handleAllowAdopt(w http.ResponseWriter, r *http.Request) {
	if !s.guard(w, r) {
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method", http.StatusMethodNotAllowed)
		return
	}
	s.openAdoptWindow()
	writeJSON(w, map[string]any{"ok": true, "seconds": s.adoptSecondsLeft()})
}

// handlePair publishes this server's LAN URL + token to the TV's pairing topic.
// The user enters the code shown on the TV; the TV then pulls the announcement.
func (s *Server) handlePair(w http.ResponseWriter, r *http.Request) {
	if !s.guard(w, r) {
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method", http.StatusMethodNotAllowed)
		return
	}
	var in struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	url := pair.LocalURL(s.port)
	if err := pair.Publish(r.Context(), in.Code, url, s.cfg.Token); err != nil {
		writeJSON(w, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	// Remember this for the web UI so the next visit (or the next binary
	// upgrade) shows "last paired with code X at HH:MM" rather than feeling
	// like the server has amnesia.  Failures to save are non-fatal — the
	// pair publish already succeeded, so the TV side is good.
	s.cfg.LastPair = &config.LastPair{Code: in.Code, At: time.Now().UTC()}
	if err := s.cfg.Save(); err != nil {
		log.Printf("warning: pair succeeded but persisting LastPair failed: %v", err)
	}
	writeJSON(w, map[string]any{"ok": true, "url": url})
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

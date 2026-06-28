package transcode

import (
	"bufio"
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"
)

// nowFn is a seam so tests could fake the clock; real code uses time.Now.
var nowFn = time.Now

// idleTimeout kills a session whose playlist/segments haven't been requested in
// a while — i.e. the user stopped watching or moved on.
const idleTimeout = 90 * time.Second

// RawURLFunc builds the internal HTTP URL ffmpeg should read for an SMB path.
// (Injected so this package doesn't import the web/http layer.)
type RawURLFunc func(smbPath string) string

// Manager owns the working directory and the live session set.
type Manager struct {
	caps    *Caps
	workDir string
	rawURL  RawURLFunc

	mu       sync.Mutex
	sessions map[string]*session
}

// NewManager wires the manager and starts the idle-reaper goroutine.
func NewManager(caps *Caps, workDir string, rawURL RawURLFunc) (*Manager, error) {
	if err := os.MkdirAll(workDir, 0o755); err != nil {
		return nil, err
	}
	// Clear stale work from a previous run.
	entries, _ := filepath.Glob(filepath.Join(workDir, "*"))
	for _, e := range entries {
		os.RemoveAll(e)
	}
	m := &Manager{caps: caps, workDir: workDir, rawURL: rawURL, sessions: map[string]*session{}}
	go m.reap()
	return m, nil
}

// Caps exposes the probed capabilities (for the status page).
func (m *Manager) Caps() *Caps { return m.caps }

// EnsureSession returns a ready session for the given SMB path, starting ffmpeg
// (after probing + deciding) if one isn't already running. It blocks until the
// first segment exists so the caller can immediately redirect AVPlay to the
// playlist.
func (m *Manager) EnsureSession(ctx context.Context, smbPath string) (*session, error) {
	id := idFor(smbPath)

	m.mu.Lock()
	if s, ok := m.sessions[id]; ok && !s.isDone() {
		s.Touch()
		m.mu.Unlock()
		if err := waitReady(ctx, s); err != nil {
			return nil, err
		}
		return s, nil
	}
	m.mu.Unlock()

	in := m.rawURL(smbPath)

	// Probe + decide before committing to a session.
	mi, err := m.caps.Inspect(ctx, in)
	if err != nil {
		return nil, fmt.Errorf("probe failed: %w", err)
	}
	plan := Decide(mi)
	log.Printf("transcode %q: %s (codec v=%s a=%s/%dch)", smbPath, plan.Reason, mi.VideoCodec, mi.AudioCodec, mi.AudioChans)

	dir := filepath.Join(m.workDir, id)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}

	sctx, cancel := context.WithCancel(context.Background())
	s := &session{
		ID: id, SrcPath: smbPath, Dir: dir, Plan: plan,
		cancel: cancel, logTail: newRing(60), lastAccess: nowFn(),
	}

	args := m.caps.buildArgs(in, plan, dir)
	cmd := exec.CommandContext(sctx, m.caps.FFmpeg, args...)
	s.cmd = cmd

	stderr, _ := cmd.StderrPipe()
	if err := cmd.Start(); err != nil {
		cancel()
		os.RemoveAll(dir)
		return nil, fmt.Errorf("start ffmpeg: %w", err)
	}
	go drain(stderr, s)
	go func() {
		err := cmd.Wait()
		s.mu.Lock()
		s.done, s.exitErr = true, err
		s.mu.Unlock()
	}()

	m.mu.Lock()
	m.sessions[id] = s
	m.mu.Unlock()

	if err := waitReady(ctx, s); err != nil {
		return nil, err
	}
	return s, nil
}

// Session looks up a live session by id (used when serving segments).
func (m *Manager) Session(id string) (*session, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[id]
	return s, ok
}

func (s *session) isDone() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.done
}

// waitReady blocks until the first segment is written, ffmpeg dies, or ctx ends.
func waitReady(ctx context.Context, s *session) error {
	deadline := time.NewTimer(30 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(150 * time.Millisecond)
	defer tick.Stop()
	for {
		if s.ready() {
			return nil
		}
		if s.isDone() {
			return fmt.Errorf("ffmpeg exited before producing output: %s", s.tail())
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return fmt.Errorf("timed out waiting for transcode to start: %s", s.tail())
		case <-tick.C:
		}
	}
}

// reap stops sessions that have gone idle.
func (m *Manager) reap() {
	t := time.NewTicker(15 * time.Second)
	for range t.C {
		now := nowFn()
		m.mu.Lock()
		for id, s := range m.sessions {
			s.mu.Lock()
			idle := now.Sub(s.lastAccess) > idleTimeout
			done := s.done
			s.mu.Unlock()
			if idle || (done && now.Sub(s.lastAccess) > 10*time.Second) {
				log.Printf("reap session %s (%s)", id, s.SrcPath)
				s.stop()
				delete(m.sessions, id)
			}
		}
		m.mu.Unlock()
	}
}

func drain(r interface{ Read([]byte) (int, error) }, s *session) {
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		s.logTail.add(sc.Text())
	}
}

func (s *session) tail() string { return s.logTail.last() }

// ── tiny line ring buffer for surfacing ffmpeg's last words on failure ──────
type ring struct {
	mu   sync.Mutex
	buf  []string
	n    int
	full bool
}

func newRing(n int) *ring { return &ring{buf: make([]string, n)} }
func (r *ring) add(line string) {
	r.mu.Lock()
	r.buf[r.n] = line
	r.n = (r.n + 1) % len(r.buf)
	if r.n == 0 {
		r.full = true
	}
	r.mu.Unlock()
}
func (r *ring) last() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.full && r.n == 0 {
		return "(no output)"
	}
	// Return the most recent non-empty line.
	for i := 0; i < len(r.buf); i++ {
		idx := (r.n - 1 - i + len(r.buf)) % len(r.buf)
		if r.buf[idx] != "" {
			return r.buf[idx]
		}
	}
	return "(no output)"
}

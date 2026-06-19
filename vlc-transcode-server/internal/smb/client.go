// Package smb wraps go-smb2 with the few operations this server needs: list a
// folder (for the web UI's "test browse") and open a file as a seekable reader
// (so ffmpeg/HTTP can range-read it). A single share is mounted and kept open;
// if the session drops we transparently re-dial on the next call.
package smb

import (
	"context"
	"fmt"
	"io"
	"net"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/hirochachacha/go-smb2"

	"github.com/PatrickSt1991/vlc-tizen-tv/vlc-transcode-server/internal/config"
)

// Entry is one item in a folder listing.
type Entry struct {
	Name  string `json:"name"`
	IsDir bool   `json:"isDir"`
	Size  int64  `json:"size"`
}

// File is a seekable handle to one SMB file plus its size.
type File struct {
	*smb2.File
	Size int64
}

// Client holds the live session/mount and re-dials on demand.
type Client struct {
	cfg *config.SMB

	mu      sync.Mutex
	conn    net.Conn
	session *smb2.Session
	share   *smb2.Share
}

// New returns a client bound to the given SMB settings. Nothing connects until
// the first call.
func New(cfg *config.SMB) *Client { return &Client{cfg: cfg} }

// normalise converts an incoming "/Movies/x.mkv" into the backslash-free,
// leading-slash-free form go-smb2 expects, and blocks ".." traversal so a
// crafted path can't escape the share.
func normalise(p string) (string, error) {
	p = strings.ReplaceAll(p, "\\", "/")
	p = strings.TrimPrefix(p, "/")
	clean := path.Clean("/" + p)
	if strings.Contains(clean, "..") {
		return "", fmt.Errorf("invalid path")
	}
	return strings.TrimPrefix(clean, "/"), nil
}

// ensure (re)establishes the mount if needed. Caller holds c.mu.
func (c *Client) ensure() error {
	if c.share != nil {
		return nil
	}
	if c.cfg.Host == "" || c.cfg.Share == "" {
		return fmt.Errorf("SMB not configured")
	}
	port := c.cfg.Port
	if port == 0 {
		port = 445
	}
	d := net.Dialer{Timeout: 10 * time.Second}
	conn, err := d.Dial("tcp", fmt.Sprintf("%s:%d", c.cfg.Host, port))
	if err != nil {
		return fmt.Errorf("dial %s: %w", c.cfg.Host, err)
	}
	init := &smb2.NTLMInitiator{Domain: c.cfg.Domain}
	if !c.cfg.Anonymous {
		init.User = c.cfg.User
		init.Password = c.cfg.Pass
	} else {
		// A guest/null session: many NAS boxes accept an empty user.
		init.User = c.cfg.User // often "" or "Guest"
	}
	dialer := &smb2.Dialer{Initiator: init}
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	sess, err := dialer.DialContext(ctx, conn)
	if err != nil {
		conn.Close()
		return fmt.Errorf("smb auth: %w", err)
	}
	share, err := sess.Mount(c.cfg.Share)
	if err != nil {
		sess.Logoff()
		conn.Close()
		return fmt.Errorf("mount %q: %w", c.cfg.Share, err)
	}
	c.conn, c.session, c.share = conn, sess, share
	return nil
}

// reset tears the session down so the next call re-dials. Caller holds c.mu.
func (c *Client) reset() {
	if c.share != nil {
		c.share.Umount()
	}
	if c.session != nil {
		c.session.Logoff()
	}
	if c.conn != nil {
		c.conn.Close()
	}
	c.share, c.session, c.conn = nil, nil, nil
}

// Probe forces a connect (used by the web UI's "Test connection" button).
func (c *Client) Probe() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.reset() // always test fresh credentials
	return c.ensure()
}

// List returns the entries of a folder ("" or "/" = share root).
func (c *Client) List(p string) ([]Entry, error) {
	rel, err := normalise(p)
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.ensure(); err != nil {
		return nil, err
	}
	dir := rel
	if dir == "" {
		dir = "."
	}
	infos, err := c.share.ReadDir(dir)
	if err != nil {
		c.reset() // drop a possibly-stale session
		return nil, err
	}
	out := make([]Entry, 0, len(infos))
	for _, fi := range infos {
		out = append(out, Entry{Name: fi.Name(), IsDir: fi.IsDir(), Size: fi.Size()})
	}
	return out, nil
}

// Open returns a seekable handle to a file. The caller must Close it.
func (c *Client) Open(p string) (*File, error) {
	rel, err := normalise(p)
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if err := c.ensure(); err != nil {
		return nil, err
	}
	f, err := c.share.Open(rel)
	if err != nil {
		c.reset()
		return nil, err
	}
	fi, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	if fi.IsDir() {
		f.Close()
		return nil, fmt.Errorf("%s is a directory", p)
	}
	return &File{File: f, Size: fi.Size()}, nil
}

// ensure *smb2.File satisfies io.ReadSeeker for http.ServeContent.
var _ io.ReadSeeker = (*smb2.File)(nil)

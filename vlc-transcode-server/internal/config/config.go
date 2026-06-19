// Package config holds the server's persisted, web-editable settings.
//
// Everything a non-technical user must set (SMB share + credentials) lives in a
// single JSON file so the web UI can read/write it without anyone touching a
// shell. The file is created on first save; missing/blank fields are fine — the
// server just reports "not configured" until the SMB section is filled in.
package config

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

// SMB holds the connection details for the one share we read media from.
type SMB struct {
	Host      string `json:"host"`      // e.g. "192.168.1.10"
	Port      int    `json:"port"`      // usually 445
	Share     string `json:"share"`     // e.g. "Media"
	User      string `json:"user"`      // empty when Anonymous
	Pass      string `json:"pass"`      // empty when Anonymous
	Domain    string `json:"domain"`    // usually empty
	Anonymous bool   `json:"anonymous"` // guest/null session
}

// Config is the whole persisted document.
type Config struct {
	SMB SMB `json:"smb"`

	// Encoder lets a user override the auto-detected ffmpeg encoder if the
	// pick misbehaves on their box (e.g. "libx264", "h264_vaapi"). Empty =
	// auto-detect.
	Encoder string `json:"encoder,omitempty"`

	// Token is a long random secret minted on first run. The TV receives it
	// during pairing and sends it on /play, so a random LAN device can't drive
	// the transcoder. It rides in URLs the TV builds automatically — no user
	// friction.
	Token string `json:"token,omitempty"`

	path string     // backing file; not serialised
	mu   sync.Mutex // guards Save against concurrent web writes
}

// Configured reports whether enough is set to attempt an SMB connection.
func (c *Config) Configured() bool {
	return c.SMB.Host != "" && c.SMB.Share != ""
}

// EnsureToken mints the pairing secret on first run and persists it.
func (c *Config) EnsureToken() error {
	if c.Token != "" {
		return nil
	}
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return err
	}
	c.Token = hex.EncodeToString(b)
	return c.Save()
}

// Load reads the config file, returning an empty (but usable) Config if it does
// not exist yet. Only a malformed existing file is an error.
func Load(path string) (*Config, error) {
	c := &Config{path: path, SMB: SMB{Port: 445}}
	b, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return c, nil
		}
		return nil, err
	}
	if err := json.Unmarshal(b, c); err != nil {
		return nil, err
	}
	c.path = path
	if c.SMB.Port == 0 {
		c.SMB.Port = 445
	}
	return c, nil
}

// Save atomically persists the current config to disk.
func (c *Config) Save() error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if err := os.MkdirAll(filepath.Dir(c.path), 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	tmp := c.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, c.path)
}

// View is the JSON shape sent to the web UI — no mutex, password masked.
type View struct {
	SMB     SMB    `json:"smb"`
	Encoder string `json:"encoder,omitempty"`
}

// Redacted returns a lock-free view safe to send to the web UI.
func (c *Config) Redacted() View {
	v := View{SMB: c.SMB, Encoder: c.Encoder}
	v.SMB.Pass = "" // never leak the stored password
	return v
}

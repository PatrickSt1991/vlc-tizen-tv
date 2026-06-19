// Package pair implements the TV handshake. It reuses the app's existing
// ntfy.sh pairing-code transport (see the TV app's url-drop.js): the TV mints a
// long code and shows it; here we publish this server's LAN URL + token to the
// derived topic so the TV can discover and save it.
//
// A SEPARATE topic suffix ("-srv") is used so a server announcement never
// collides with the "Get URL from device" play feature, which polls the bare
// "vlctv-<code>" topic.
package pair

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
	"time"
)

const ntfyBase = "https://ntfy.sh"

// Announce is the JSON the TV receives and stores.
type Announce struct {
	Type  string `json:"type"`  // always "vlc-transcode-server"
	URL   string `json:"url"`   // e.g. "http://192.168.1.50:8200"
	Token string `json:"token"` // sent back on /play
	Name  string `json:"name"`  // friendly box name
}

// topicFor maps a TV pairing code to the server-announce topic.
func topicFor(code string) string { return "vlctv-" + code + "-srv" }

// Publish posts this server's details to the TV's pairing topic.
func Publish(ctx context.Context, code, serverURL, token string) error {
	code = strings.TrimSpace(code)
	if code == "" {
		return fmt.Errorf("empty pairing code")
	}
	ann := Announce{Type: "vlc-transcode-server", URL: serverURL, Token: token, Name: hostname()}
	body, _ := json.Marshal(ann)

	ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, ntfyBase+"/"+topicFor(code), bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	// ntfy keeps the last message cached so the TV can pull it on demand later.
	req.Header.Set("Cache", "yes")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("ntfy returned %s", resp.Status)
	}
	return nil
}

// LocalURL guesses this box's LAN URL by checking which source address the OS
// would use to reach the internet — that's the interface the TV reaches us on.
func LocalURL(port int) string {
	ip := outboundIP()
	if ip == "" {
		ip = "127.0.0.1"
	}
	return fmt.Sprintf("http://%s:%d", ip, port)
}

func outboundIP() string {
	// No packets are actually sent for a UDP "connect"; it just resolves the
	// route and picks the local source address.
	c, err := net.Dial("udp", "8.8.8.8:80")
	if err != nil {
		return ""
	}
	defer c.Close()
	if a, ok := c.LocalAddr().(*net.UDPAddr); ok {
		return a.IP.String()
	}
	return ""
}

func hostname() string {
	h, err := os.Hostname()
	if err != nil || h == "" {
		return "VLC Transcode Server"
	}
	return h
}

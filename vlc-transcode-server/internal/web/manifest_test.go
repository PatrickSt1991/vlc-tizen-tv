package web

import "testing"

func TestRewriteManifest(t *testing.T) {
	in := []byte("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.000,\nseg00000.ts\n#EXTINF:4.000,\nseg00001.ts\n")
	out := string(rewriteManifest(in, "/hls/abc123/"))

	want := "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.000,\n/hls/abc123/seg00000.ts\n#EXTINF:4.000,\n/hls/abc123/seg00001.ts\n"
	if out != want {
		t.Fatalf("rewrite mismatch:\n got: %q\nwant: %q", out, want)
	}
}

// The src parameter is the one place a paired TV can name an arbitrary URL for
// ffmpeg to open, so the guard around it is worth pinning down.
func TestValidateRelayURL(t *testing.T) {
	ok := []string{
		"http://192.168.1.42:8128/local/stream?path=/opt/usr/media/x.mkv&key=abc",
		"http://10.0.0.5:8128/local/stream?path=/a.mkv",
		"http://172.16.3.9:8128/local/stream?path=/a.mkv",
		"https://192.168.0.2:8128/local/stream?path=/a.mkv",
		"http://169.254.7.7:8128/local/stream?path=/a.mkv", // link-local, e.g. no DHCP
	}
	for _, u := range ok {
		if err := validateRelayURL(u); err != nil {
			t.Errorf("validateRelayURL(%q) = %v, want nil", u, err)
		}
	}

	bad := []string{
		"http://127.0.0.1:8200/api/config",  // the box's own admin API
		"http://localhost:8200/api/config",  // same, by name
		"http://[::1]:8200/api/config",      // same, IPv6
		"http://0.0.0.0:8200/",              // unspecified
		"http://example.com/x.mkv",          // off-LAN, and DNS-resolvable
		"http://8.8.8.8/x.mkv",              // public IP
		"http://tv.local:8128/local/stream", // hostname, so rebindable
		"file:///etc/passwd",                // not HTTP at all
		"ftp://192.168.1.42/x.mkv",          // ditto
		"",                                  // empty
	}
	for _, u := range bad {
		if err := validateRelayURL(u); err == nil {
			t.Errorf("validateRelayURL(%q) = nil, want an error", u)
		}
	}
}

func TestIsLoopback(t *testing.T) {
	yes := []string{"127.0.0.1:54321", "[::1]:8200", "127.0.0.1", "127.1.2.3:9"}
	for _, a := range yes {
		if !isLoopback(a) {
			t.Errorf("isLoopback(%q) = false, want true", a)
		}
	}
	no := []string{"192.168.1.5:54321", "10.0.0.1:1", "[fe80::1]:80", "", "garbage"}
	for _, a := range no {
		if isLoopback(a) {
			t.Errorf("isLoopback(%q) = true, want false", a)
		}
	}
}

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

package transcode

import "testing"

func TestDecideSurround(t *testing.T) {
	cases := []struct {
		name     string
		mi       MediaInfo
		surround string
		copyA    bool
		enc      string
	}{
		// Historical behaviour must be untouched when surround is off.
		{"stereo aac copied", MediaInfo{VideoCodec: "h264", AudioCodec: "aac", AudioChans: 2}, SurroundOff, true, ""},
		{"5.1 aac copied", MediaInfo{VideoCodec: "h264", AudioCodec: "aac", AudioChans: 6}, SurroundOff, true, ""},
		{"dts 5.1 to ac3", MediaInfo{VideoCodec: "h264", AudioCodec: "dts", AudioChans: 6}, SurroundOff, false, "ac3"},
		{"dts stereo to aac", MediaInfo{VideoCodec: "h264", AudioCodec: "dts", AudioChans: 2}, SurroundOff, false, "aac"},

		// The issue-63 case: a codec the TV decodes fine but can't bitstream.
		{"flac 5.1 to eac3", MediaInfo{VideoCodec: "h264", AudioCodec: "flac", AudioChans: 6}, SurroundEAC3, false, "eac3"},
		{"flac 5.1 to ac3", MediaInfo{VideoCodec: "h264", AudioCodec: "flac", AudioChans: 6}, SurroundAC3, false, "ac3"},
		{"aac 5.1 to eac3", MediaInfo{VideoCodec: "h264", AudioCodec: "aac", AudioChans: 6}, SurroundEAC3, false, "eac3"},
		{"truehd 7.1 to eac3", MediaInfo{VideoCodec: "hevc", AudioCodec: "truehd", AudioChans: 8}, SurroundEAC3, false, "eac3"},

		// Already bitstreamable, or not multichannel: leave it alone.
		{"ac3 5.1 stays copied", MediaInfo{VideoCodec: "h264", AudioCodec: "ac3", AudioChans: 6}, SurroundEAC3, true, ""},
		{"eac3 5.1 stays copied", MediaInfo{VideoCodec: "h264", AudioCodec: "eac3", AudioChans: 6}, SurroundEAC3, true, ""},
		{"flac stereo to aac", MediaInfo{VideoCodec: "h264", AudioCodec: "flac", AudioChans: 2}, SurroundEAC3, false, "aac"},
		{"aac stereo stays copied", MediaInfo{VideoCodec: "h264", AudioCodec: "aac", AudioChans: 2}, SurroundEAC3, true, ""},

		// No audio track at all must not produce an encoder.
		{"video only", MediaInfo{VideoCodec: "h264"}, SurroundEAC3, true, ""},

		// An unknown mode string is treated as off, never as "encode something".
		{"garbage mode is off", MediaInfo{VideoCodec: "h264", AudioCodec: "flac", AudioChans: 6}, "dts-hd", false, "ac3"},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			mi := c.mi
			p := Decide(&mi, c.surround)
			if p.CopyAudio != c.copyA {
				t.Errorf("CopyAudio = %v, want %v (reason: %s)", p.CopyAudio, c.copyA, p.Reason)
			}
			if p.AudioEnc != c.enc {
				t.Errorf("AudioEnc = %q, want %q (reason: %s)", p.AudioEnc, c.enc, p.Reason)
			}
		})
	}
}

// Video handling must be independent of the audio policy.
func TestDecideVideoUnaffectedBySurround(t *testing.T) {
	for _, mode := range []string{SurroundOff, SurroundAC3, SurroundEAC3} {
		mi := MediaInfo{VideoCodec: "vp9", AudioCodec: "flac", AudioChans: 6}
		if p := Decide(&mi, mode); p.CopyVideo {
			t.Errorf("surround=%s: vp9 should be transcoded, not copied", mode)
		}
		mi = MediaInfo{VideoCodec: "h264", AudioCodec: "flac", AudioChans: 6}
		if p := Decide(&mi, mode); !p.CopyVideo {
			t.Errorf("surround=%s: h264 should be copied", mode)
		}
	}
}

// Changing the policy must not reuse a session cached under the old one.
func TestIDForIncludesSurround(t *testing.T) {
	a := idFor("smb:Movies/x.mkv", SurroundOff)
	b := idFor("smb:Movies/x.mkv", SurroundEAC3)
	if a == b {
		t.Fatalf("session id ignored the surround policy: %s", a)
	}
}

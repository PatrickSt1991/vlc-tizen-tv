package transcode

// What the Samsung Tizen TVs in scope can decode in-app via AVPlay. Video: H.264
// and HEVC are the safe set. Audio: AAC/AC3/EAC3/MP3 play; DTS and TrueHD/MLP do
// not (the hardware wall we documented — even Plex plays them silent). Keeping
// these as plain sets makes the policy easy to read and to widen later.
var tvVideoOK = map[string]bool{
	"h264": true,
	"hevc": true, "h265": true,
}
var tvAudioOK = map[string]bool{
	"aac": true, "ac3": true, "eac3": true,
	"mp3": true, "mp2": true,
}

// Plan is the decision for one file.
type Plan struct {
	CopyVideo bool   // remux video stream untouched
	CopyAudio bool   // remux audio stream untouched
	AudioEnc  string // ffmpeg audio encoder when CopyAudio is false
	Reason    string // human-readable, for logs and the web UI

	mi *MediaInfo
}

// Decide chooses the cheapest treatment that yields a TV-playable HLS stream:
//
//   - both streams already fine        → remux only (copy/copy, ~no CPU)
//   - only the audio codec is the wall → copy video, re-encode just the audio
//   - video codec unsupported          → hardware-transcode video + fix audio
//
// Re-encoded audio targets AC3 when the source is multichannel (keeps 5.1) and
// AAC for stereo — both decode on every TV in scope.
func Decide(mi *MediaInfo) Plan {
	videoOK := mi.VideoCodec == "" || tvVideoOK[mi.VideoCodec]
	audioOK := mi.AudioCodec == "" || tvAudioOK[mi.AudioCodec]

	p := Plan{mi: mi, CopyVideo: videoOK, CopyAudio: audioOK}
	if !audioOK {
		if mi.AudioChans > 2 {
			p.AudioEnc = "ac3"
		} else {
			p.AudioEnc = "aac"
		}
	}

	switch {
	case videoOK && audioOK:
		p.Reason = "remux only — both streams TV-compatible"
	case videoOK && !audioOK:
		p.Reason = "copy video, transcode audio " + mi.AudioCodec + "→" + p.AudioEnc
	default:
		p.Reason = "transcode video " + mi.VideoCodec + "→h264"
		if !audioOK {
			p.Reason += ", audio " + mi.AudioCodec + "→" + p.AudioEnc
		}
	}
	return p
}

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

// bitstreamOK is the set of audio codecs the TV can hand to a soundbar or AVR
// *untouched* over HDMI-ARC / eARC / optical, because they have an IEC 61937
// framing. Everything else — FLAC, AAC, PCM, Vorbis, Opus — the TV decodes
// itself, and what leaves the set is then LPCM, which plain ARC can only carry
// as 2.0. That's why a 5.1 FLAC file arrives at the soundbar as stereo
// (issue #63): nothing is broken, the format simply has no multichannel path
// off the TV. Re-encoding into one of these is the only way to keep 5.1.
//
// Deliberately narrower than tvAudioOK: DTS bitstreams fine on receivers, but
// Samsung dropped DTS decoding, so the TV can't even get it out of the
// container to pass it on.
var bitstreamOK = map[string]bool{
	"ac3": true, "eac3": true,
}

// Surround modes for Config.Surround — the target the user wants multichannel
// audio delivered in.
const (
	// SurroundOff keeps the historical behaviour: only re-encode audio the TV
	// cannot decode at all. Multichannel AAC still reaches the soundbar as
	// PCM 2.0.
	SurroundOff = "off"
	// SurroundEAC3 re-encodes any non-bitstreamable multichannel track to
	// E-AC-3 (Dolby Digital Plus) 5.1. Best quality of the two, supported by
	// every TV in scope and by ARC/eARC soundbars from ~2015 on.
	SurroundEAC3 = "eac3"
	// SurroundAC3 targets plain AC-3 (Dolby Digital) 5.1 instead — lower
	// ceiling, but the safe pick for older receivers that reject DD+.
	SurroundAC3 = "ac3"
)

// NormaliseSurround maps stored/posted values onto a known mode, defaulting to
// off so an empty config (or a typo) never silently re-encodes anything.
func NormaliseSurround(mode string) string {
	switch mode {
	case SurroundEAC3, SurroundAC3:
		return mode
	default:
		return SurroundOff
	}
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
// surround adds a second reason to touch the audio: a track the TV can decode
// perfectly well still leaves the set as PCM 2.0 unless it's in a format the TV
// can bitstream, so when the user asks for surround we re-encode multichannel
// audio into AC-3 / E-AC-3 even though nothing is "broken" about it.
//
// With surround off, re-encoded audio targets AC-3 when the source is
// multichannel (keeps 5.1) and AAC for stereo — both decode on every TV in
// scope.
func Decide(mi *MediaInfo, surround string) Plan {
	surround = NormaliseSurround(surround)

	videoOK := mi.VideoCodec == "" || tvVideoOK[mi.VideoCodec]
	audioOK := mi.AudioCodec == "" || tvAudioOK[mi.AudioCodec]
	multichannel := mi.AudioChans > 2

	// A decodable-but-not-bitstreamable multichannel track: playable today,
	// but downmixed on the way out. Only worth touching when asked.
	downmixed := surround != SurroundOff && mi.AudioCodec != "" &&
		multichannel && !bitstreamOK[mi.AudioCodec]

	p := Plan{mi: mi, CopyVideo: videoOK, CopyAudio: audioOK && !downmixed}
	if !p.CopyAudio && mi.AudioCodec != "" {
		switch {
		case surround != SurroundOff && multichannel:
			p.AudioEnc = surround
		case multichannel:
			p.AudioEnc = "ac3"
		default:
			p.AudioEnc = "aac"
		}
	}

	switch {
	case videoOK && p.CopyAudio:
		p.Reason = "remux only — both streams TV-compatible"
	case videoOK && downmixed && audioOK:
		p.Reason = "copy video, transcode audio " + mi.AudioCodec + "→" + p.AudioEnc +
			" so the TV can bitstream " + chanLabel(mi.AudioChans) + " instead of downmixing to stereo"
	case videoOK:
		p.Reason = "copy video, transcode audio " + mi.AudioCodec + "→" + p.AudioEnc
	default:
		p.Reason = "transcode video " + mi.VideoCodec + "→h264"
		if !p.CopyAudio {
			p.Reason += ", audio " + mi.AudioCodec + "→" + p.AudioEnc
		}
	}
	return p
}

// chanLabel renders a channel count the way a user thinks about it, for log and
// UI reasons ("6" means nothing; "5.1" does).
func chanLabel(n int) string {
	switch n {
	case 6:
		return "5.1"
	case 8:
		return "7.1"
	case 7:
		return "6.1"
	default:
		return "multichannel"
	}
}

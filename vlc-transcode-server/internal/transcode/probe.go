package transcode

import (
	"context"
	"encoding/json"
	"os/exec"
	"strconv"
	"time"
)

// MediaInfo is the slice of ffprobe output we care about.
type MediaInfo struct {
	VideoCodec string  // "h264", "hevc", "vp9", ... ("" = no video)
	AudioCodec string  // "dts", "truehd", "aac", "ac3", ... of the default track
	AudioChans int     // channel count of that track
	Duration   float64 // seconds (0 if unknown)
}

// ffprobe JSON shapes (only the fields we read).
type ffStream struct {
	CodecType     string `json:"codec_type"`
	CodecName     string `json:"codec_name"`
	Channels      int    `json:"channels"`
	Disposition   struct {
		Default int `json:"default"`
	} `json:"disposition"`
}
type ffFormat struct {
	Duration string `json:"duration"`
}
type ffProbeOut struct {
	Streams []ffStream `json:"streams"`
	Format  ffFormat   `json:"format"`
}

// Inspect runs ffprobe against a (local raw-bridge) URL and summarises it. We
// pick the *default* audio track if the container flags one, else the first —
// that's the track AVPlay would default to, so it's the one whose codec decides
// whether the TV can play the file as-is.
func (c *Caps) Inspect(ctx context.Context, url string) (*MediaInfo, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, c.FFprobe,
		"-hide_banner", "-loglevel", "error",
		"-print_format", "json",
		"-show_streams", "-show_format",
		url,
	)
	out, err := cmd.Output()
	if err != nil {
		return nil, err
	}
	var probe ffProbeOut
	if err := json.Unmarshal(out, &probe); err != nil {
		return nil, err
	}

	mi := &MediaInfo{}
	var firstAudio *ffStream
	var defAudio *ffStream
	for i := range probe.Streams {
		s := &probe.Streams[i]
		switch s.CodecType {
		case "video":
			if mi.VideoCodec == "" {
				mi.VideoCodec = s.CodecName
			}
		case "audio":
			if firstAudio == nil {
				firstAudio = s
			}
			if defAudio == nil && s.Disposition.Default == 1 {
				defAudio = s
			}
		}
	}
	if a := defAudio; a != nil {
		mi.AudioCodec, mi.AudioChans = a.CodecName, a.Channels
	} else if firstAudio != nil {
		mi.AudioCodec, mi.AudioChans = firstAudio.CodecName, firstAudio.Channels
	}
	if d, err := strconv.ParseFloat(probe.Format.Duration, 64); err == nil {
		mi.Duration = d
	}
	return mi, nil
}

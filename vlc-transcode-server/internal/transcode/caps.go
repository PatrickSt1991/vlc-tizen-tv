package transcode

import (
	"context"
	"os/exec"
	"strings"
	"time"
)

// Caps describes what this box's ffmpeg can actually do, probed once at
// startup. The whole point of probing (rather than configuring) is that the
// same image can be dropped on a Rockchip board, an Intel mini-PC, a Pi, or a
// plain VM and pick the fastest encoder it finds — falling back to libx264 so
// it always works somewhere.
type Caps struct {
	FFmpeg  string // resolved ffmpeg path
	FFprobe string // resolved ffprobe path

	// VideoEncoder is the chosen H.264 encoder name (e.g. "h264_vaapi").
	VideoEncoder string
	// HWAccel is the matching family ("vaapi","v4l2m2m","nvenc","none").
	HWAccel string
	// VAAPIDevice is the render node for VAAPI, if that family was chosen.
	VAAPIDevice string
}

// encoderPriority lists H.264 encoders fastest/most-desirable first. Auto-pick
// walks this and takes the first one ffmpeg reports as available; libx264 is
// last and effectively always present, so detection never comes up empty.
//
// Cross-platform note: encoders that don't exist on the running host just
// won't be in ffmpeg's -encoders list, so the same priority array is safe to
// use on Linux containers, native Windows .exe, and native macOS — each OS
// auto-picks the encoder its ffmpeg actually ships with.
var encoderPriority = []struct {
	name   string
	family string
}{
	{"h264_rkmpp", "rkmpp"},               // Rockchip RK3588/3568 (Linux native, custom ffmpeg)
	{"h264_videotoolbox", "videotoolbox"}, // macOS (Apple Silicon + Intel Macs)
	{"h264_vaapi", "vaapi"},               // Linux Intel/AMD (Mesa)
	{"h264_nvenc", "nvenc"},               // NVIDIA / Jetson — cross-platform
	{"h264_qsv", "qsv"},                   // Intel QuickSync — Windows + Linux
	{"h264_amf", "amf"},                   // AMD AMF — Windows (and rare Linux builds)
	{"h264_v4l2m2m", "v4l2m2m"},           // Amlogic and many generic ARM SoCs
	{"libx264", "none"},                   // software — universal fallback
}

// Probe locates ffmpeg/ffprobe and picks an encoder. override forces a specific
// encoder name (from config) instead of auto-detection; an empty override means
// auto.
func Probe(override string) (*Caps, error) {
	ff, err := exec.LookPath("ffmpeg")
	if err != nil {
		return nil, err
	}
	fp, err := exec.LookPath("ffprobe")
	if err != nil {
		return nil, err
	}
	c := &Caps{FFmpeg: ff, FFprobe: fp}

	avail := listEncoders(ff)

	// Honour an explicit override if ffmpeg actually has it.
	if override != "" && avail[override] {
		c.VideoEncoder = override
		c.HWAccel = familyOf(override)
	} else {
		for _, e := range encoderPriority {
			if avail[e.name] {
				c.VideoEncoder = e.name
				c.HWAccel = e.family
				break
			}
		}
	}
	if c.VideoEncoder == "" { // extremely unlikely; ffmpeg without libx264
		c.VideoEncoder = "libx264"
		c.HWAccel = "none"
	}
	if c.HWAccel == "vaapi" {
		c.VAAPIDevice = firstExisting([]string{"/dev/dri/renderD128", "/dev/dri/renderD129"})
	}
	return c, nil
}

func familyOf(enc string) string {
	for _, e := range encoderPriority {
		if e.name == enc {
			return e.family
		}
	}
	return "none"
}

// listEncoders returns the set of encoder names `ffmpeg -encoders` reports.
func listEncoders(ffmpeg string) map[string]bool {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, ffmpeg, "-hide_banner", "-encoders").Output()
	set := map[string]bool{}
	if err != nil {
		return set
	}
	// Each encoder row looks like: " V..... libx264   libx264 H.264 ...".
	for _, line := range strings.Split(string(out), "\n") {
		f := strings.Fields(line)
		if len(f) >= 2 && len(f[0]) == 6 { // the flags column is 6 chars
			set[f[1]] = true
		}
	}
	return set
}

func firstExisting(paths []string) string {
	for _, p := range paths {
		if fileExists(p) {
			return p
		}
	}
	return ""
}

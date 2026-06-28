package transcode

import (
	"context"
	"os/exec"
	"runtime"
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
// walks this and takes the first one that's BOTH listed by ffmpeg AND runnable
// on the current OS; libx264 is last and effectively always present, so
// detection never comes up empty.
//
// The OS gate matters because some ffmpeg builds compile an encoder in for
// cross-platform consistency even when its runtime isn't there.  BtbN's
// Windows build, for instance, still lists h264_vaapi in -encoders output
// (libva linked in), but VAAPI has no working backend on Windows — picking it
// would fail at runtime with "Error opening output files: Invalid argument"
// the moment ffmpeg tries to open /dev/dri.  Without the gate, our auto-pick
// chose h264_vaapi on the Windows build over the actually-working h264_qsv /
// h264_nvenc / h264_amf below it.  The "oses" field restricts each encoder
// family to the operating systems where its runtime actually exists.
var encoderPriority = []struct {
	name   string
	family string
	oses   []string // matched against runtime.GOOS; nil means "any OS"
}{
	{"h264_rkmpp", "rkmpp", []string{"linux"}},                // Rockchip RK3588/3568 (custom ffmpeg, Linux only)
	{"h264_videotoolbox", "videotoolbox", []string{"darwin"}}, // macOS hardware encoder
	{"h264_vaapi", "vaapi", []string{"linux"}},                // Mesa / libva — Linux only
	{"h264_nvenc", "nvenc", []string{"linux", "windows"}},     // NVIDIA / Jetson
	{"h264_qsv", "qsv", []string{"linux", "windows"}},         // Intel QuickSync
	{"h264_amf", "amf", []string{"windows"}},                  // AMD AMF — Windows only in practice
	{"h264_v4l2m2m", "v4l2m2m", []string{"linux"}},            // ARM SoCs (Amlogic, etc.) — Linux only
	{"libx264", "none", nil},                                  // software — any OS
}

// osMatches reports whether the encoder can run on runtime.GOOS.  Nil oses
// means "no restriction".
func osMatches(oses []string) bool {
	if oses == nil {
		return true
	}
	for _, o := range oses {
		if o == runtime.GOOS {
			return true
		}
	}
	return false
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

	// Honour an explicit override if ffmpeg actually has it — the user is
	// telling us they know better than the auto-detect.  Skip the OS gate
	// here; if they ask for h264_vaapi on Windows they get the obvious
	// runtime error rather than a silent fallback that's harder to debug.
	if override != "" && avail[override] {
		c.VideoEncoder = override
		c.HWAccel = familyOf(override)
	} else {
		for _, e := range encoderPriority {
			if !osMatches(e.oses) {
				continue
			}
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

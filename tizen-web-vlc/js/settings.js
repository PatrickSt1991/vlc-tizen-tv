/* Persistent user preferences + TV-capability detection.
 *
 * Settings are stored in localStorage under `vlctv_settings_v1` so they
 * survive app restarts.  TV info / codec support is queried at runtime from
 * tizen.systeminfo, webapis.productinfo, and HTMLVideoElement.canPlayType. */

var Settings = (function () {
    var KEY = 'vlctv_settings_v1';
    var defaults = {
        audioLang:        '',          // '' = auto (use file's default), or ISO code
        subtitleLang:     'off',       // 'off' = no subs, '' = auto-pick first, or ISO code
        repeatMode:       'off',       // 'off' | 'one'
        autoPlay:         false,       // auto-play the next file in the folder when one finishes
        // ── Subtitle appearance (applied to the painted overlay) ──────────
        subtitleSize:     'medium',    // 'small' | 'medium' | 'large' | 'xlarge'
        subtitleFont:     'sans',      // 'sans' | 'serif' | 'mono'
        subtitlePosition: 'bottom',    // 'bottom' | 'middle' | 'top'
        subtitleBg:       'none'       // 'none' | 'box'  (translucent box behind text)
    };
    var cache = null;

    function load() {
        if (cache) return cache;
        var stored = {};
        try {
            var raw = localStorage.getItem(KEY);
            stored = raw ? JSON.parse(raw) : {};
        } catch (e) { stored = {}; }
        // Build from defaults so newly-added keys always have a value, even
        // when the stored blob predates them.
        cache = {};
        for (var k in defaults)
            cache[k] = (stored && k in stored) ? stored[k] : defaults[k];
        return cache;
    }
    function save() {
        try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch (e) {}
    }
    function get(k)     { return load()[k]; }
    function setItem(k, v) { load(); cache[k] = v; save(); }

    return { get: get, set: setItem };
})();


var TvInfo = (function () {
    /* Fetch the BUILD info async then call cb({model, manufacturer, buildVersion, ...}). */
    function getBuild(cb) {
        if (typeof tizen === 'undefined' || !tizen.systeminfo) { cb({}); return; }
        try {
            tizen.systeminfo.getPropertyValue('BUILD',
                function (b) {
                    cb({
                        model:            b.model,
                        manufacturer:     b.manufacturer,
                        buildVersion:     b.buildVersion,
                        buildDescription: b.buildDescription,
                        buildReleaseDate: b.buildReleaseDate
                    });
                },
                function () { cb({}); }
            );
        } catch (e) { cb({}); }
    }

    /* webapis.productinfo is a Samsung TV-specific extension — try but tolerate
     * its absence. */
    function getProductInfo() {
        var out = {};
        try {
            if (typeof webapis !== 'undefined' && webapis.productinfo) {
                try { out.realModel       = webapis.productinfo.getRealModel(); }       catch (e) {}
                try { out.firmwareVersion = webapis.productinfo.getFirmware(); }        catch (e) {}
                try { out.tvName          = webapis.productinfo.getName(); }            catch (e) {}
                try { out.model           = webapis.productinfo.getModel(); }           catch (e) {}
                try { out.smartTVServer   = webapis.productinfo.getSmartTVServerVersion(); } catch (e) {}
            }
        } catch (e) {}
        return out;
    }

    /* HTML5 codec capability: canPlayType returns 'probably', 'maybe', or '' */
    function getCodecs() {
        var v = document.createElement('video');
        function can(type) {
            try { return v.canPlayType(type) || ''; } catch (e) { return ''; }
        }
        // The codec strings below are the standard MP4/WebM RFC 6381 ids.
        return {
            'H.264 (Baseline)': can('video/mp4; codecs="avc1.42E01E"'),
            'H.264 (Main)':     can('video/mp4; codecs="avc1.4D401E"'),
            'H.264 (High)':     can('video/mp4; codecs="avc1.64001E"'),
            'HEVC 8-bit':       can('video/mp4; codecs="hev1.1.6.L93.B0"'),
            'HEVC 10-bit':      can('video/mp4; codecs="hev1.2.4.L93.B0"'),
            'VP8':              can('video/webm; codecs="vp8"'),
            'VP9':              can('video/webm; codecs="vp9"'),
            'AV1':              can('video/mp4; codecs="av01.0.04M.08"'),
            'AAC':              can('audio/mp4; codecs="mp4a.40.2"'),
            'MP3':              can('audio/mpeg'),
            'Opus':             can('audio/webm; codecs="opus"'),
            'Vorbis':           can('audio/webm; codecs="vorbis"'),
            'MP4':              can('video/mp4'),
            'WebM':             can('video/webm'),
            'OGG':              can('video/ogg'),
            'MKV':              can('video/x-matroska'),
            'HLS':              can('application/vnd.apple.mpegurl'),
            'MPEG-DASH':        can('application/dash+xml')
        };
    }

    function getUA() { return (navigator && navigator.userAgent) || ''; }

    return { getBuild: getBuild, getProductInfo: getProductInfo, getCodecs: getCodecs, getUA: getUA };
})();


/* Curated language list — common languages for media subtitles + audio.
 * '' = auto (no preference), 'off' is added only to the subtitle picker. */
var LanguageList = (function () {
    var langs = [
        { code: '',   name: 'Auto (file default)' },
        { code: 'en', name: 'English' },
        { code: 'nl', name: 'Nederlands' },
        { code: 'de', name: 'Deutsch' },
        { code: 'fr', name: 'Français' },
        { code: 'es', name: 'Español' },
        { code: 'it', name: 'Italiano' },
        { code: 'pt', name: 'Português' },
        { code: 'ru', name: 'Русский' },
        { code: 'ja', name: '日本語' },
        { code: 'ko', name: '한국어' },
        { code: 'zh', name: '中文' },
        { code: 'ar', name: 'العربية' },
        { code: 'tr', name: 'Türkçe' },
        { code: 'pl', name: 'Polski' },
        { code: 'sv', name: 'Svenska' },
        { code: 'no', name: 'Norsk' },
        { code: 'da', name: 'Dansk' },
        { code: 'fi', name: 'Suomi' }
    ];
    return {
        forAudio:    function () { return langs; },
        forSubtitle: function () { return [{ code: 'off', name: 'Off (no subtitles)' }].concat(langs); },
        nameFor:     function (code) {
            if (code === 'off') return 'Off';
            for (var i = 0; i < langs.length; i++)
                if (langs[i].code === code) return langs[i].name;
            return code || 'Auto';
        }
    };
})();


/* Subtitle-appearance options + their resolved CSS values.  Subtitles are
 * painted by the app into #subtitle-overlay (AVPlay backend, both embedded
 * and external cues) and by the browser into video::cue (HTML5 fallback),
 * so apply() drives both surfaces from the saved Settings. */
var SubtitleStyle = (function () {
    var SIZE = [
        { code: 'small',  name: 'Small',       px: 26 },
        { code: 'medium', name: 'Medium',      px: 36 },
        { code: 'large',  name: 'Large',       px: 48 },
        { code: 'xlarge', name: 'Extra large', px: 60 }
    ];
    var FONT = [
        { code: 'sans',  name: 'Sans-serif', css: "'Segoe UI','Helvetica Neue',Helvetica,Arial,sans-serif" },
        { code: 'serif', name: 'Serif',      css: "Georgia,'Times New Roman',serif" },
        { code: 'mono',  name: 'Monospace',  css: "'Consolas','Courier New',monospace" }
    ];
    var POSITION = [
        { code: 'bottom', name: 'Bottom' },
        { code: 'middle', name: 'Middle' },
        { code: 'top',    name: 'Top' }
    ];
    var BG = [
        { code: 'none', name: 'None (outline only)' },
        { code: 'box',  name: 'Translucent box' }
    ];

    function find(list, code) {
        for (var i = 0; i < list.length; i++) if (list[i].code === code) return list[i];
        return list[0];
    }
    function nameFor(group, code) { return find(group, code).name; }

    /* Read the four subtitle settings and push them onto the document: CSS
     * custom properties (consumed by #subtitle-overlay) + a generated
     * video::cue rule for the HTML5 backend.  Position is overlay-only —
     * ::cue position is driven by the cue's own line setting, not CSS. */
    function apply() {
        if (typeof Settings === 'undefined') return;
        var size = find(SIZE, Settings.get('subtitleSize'));
        var font = find(FONT, Settings.get('subtitleFont'));
        var pos  = find(POSITION, Settings.get('subtitlePosition'));
        var bg   = Settings.get('subtitleBg');

        var root = document.documentElement;
        root.style.setProperty('--sub-size', size.px + 'px');
        root.style.setProperty('--sub-font', font.css);

        var ov = document.getElementById('subtitle-overlay');
        if (ov) {
            ov.classList.remove('sub-pos-bottom', 'sub-pos-middle', 'sub-pos-top');
            ov.classList.add('sub-pos-' + pos.code);
            ov.classList.toggle('sub-bg', bg === 'box');
        }

        // HTML5 <track> rendering: inject/update a ::cue rule.
        var styleEl = document.getElementById('subtitle-cue-style');
        if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = 'subtitle-cue-style';
            document.head.appendChild(styleEl);
        }
        styleEl.textContent =
            'video::cue{' +
            'font-size:' + size.px + 'px;' +
            'font-family:' + font.css + ';' +
            (bg === 'box' ? 'background:rgba(0,0,0,.65);'
                          : 'background:transparent;') +
            '}';
    }

    return {
        forSize:     function () { return SIZE; },
        forFont:     function () { return FONT; },
        forPosition: function () { return POSITION; },
        forBg:       function () { return BG; },
        nameForSize: function (c) { return nameFor(SIZE, c); },
        nameForFont: function (c) { return nameFor(FONT, c); },
        nameForPosition: function (c) { return nameFor(POSITION, c); },
        nameForBg:   function (c) { return nameFor(BG, c); },
        apply:       apply
    };
})();

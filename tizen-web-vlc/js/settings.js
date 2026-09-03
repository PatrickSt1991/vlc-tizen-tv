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
        shuffle:          false,       // randomize playlist order (folder + recent) instead of alphabetical
        // Route USB / internal-storage files through the paired transcode
        // server instead of straight into AVPlay.  Off by default: it only
        // helps when a transcode server is paired, and it costs the embedded
        // AVPlay fallbacks that direct local playback gets.
        localRelay:       false,
        // ── Subtitle appearance (applied to the painted overlay) ──────────
        subtitleSize:     'medium',    // 'small' | 'medium' | 'large' | 'xlarge'
        subtitleFont:     'sans',      // 'sans' | 'serif' | 'mono'
        subtitlePosition: 'bottom',    // 'bottom' | 'middle' | 'top'
        subtitleBg:       'none',      // 'none' | 'box'  (translucent box behind text)
        // ── Video geometry ────────────────────────────────────────────────
        // How the picture is fitted to the screen: see AspectRatio below.
        aspectMode:       'fit',       // 'fit' | 'fill' | 'stretch'
        // The TV's pairing code (url-drop.js mints it once and persists it
        // here).  It HAS to be listed: load() rebuilds the cache from this
        // object, so a key that isn't here is silently dropped on the next
        // launch — which regenerated the code on every app start and quietly
        // unpaired every phone that had scanned the QR.
        urlDropCode:      ''
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
 * '' = auto (no preference), 'off' is added only to the subtitle picker.
 *
 * `alt` carries the spellings a real track label uses for that language:
 * the ISO 639-2 code(s) a muxer writes into the language tag ('vie', 'ger',
 * 'chi'), the English name, and the endonym.  matchScore() below works off
 * those, so "Vietnamese (SDH)" or "[vie]" match a 'vi' preference and a
 * bare two-letter code can be required to stand as its own word — without
 * the alias list a 'vi' preference happily matched "Movie". */
var LanguageList = (function () {
    var langs = [
        { code: '',   name: 'Auto (file default)', alt: [] },
        { code: 'en', name: 'English',    alt: ['eng', 'english'] },
        { code: 'nl', name: 'Nederlands', alt: ['dut', 'nld', 'dutch', 'nederlands'] },
        { code: 'de', name: 'Deutsch',    alt: ['ger', 'deu', 'german', 'deutsch'] },
        { code: 'fr', name: 'Français',   alt: ['fre', 'fra', 'french', 'français', 'francais'] },
        { code: 'es', name: 'Español',    alt: ['spa', 'spanish', 'español', 'espanol', 'castellano'] },
        { code: 'it', name: 'Italiano',   alt: ['ita', 'italian', 'italiano'] },
        { code: 'pt', name: 'Português',  alt: ['por', 'portuguese', 'português', 'portugues', 'brazilian'] },
        { code: 'ru', name: 'Русский',    alt: ['rus', 'russian', 'русский'] },
        { code: 'ja', name: '日本語',      alt: ['jpn', 'japanese', '日本語'] },
        { code: 'ko', name: '한국어',      alt: ['kor', 'korean', '한국어'] },
        { code: 'zh', name: '中文',        alt: ['chi', 'zho', 'chinese', 'mandarin', 'cantonese', '中文'] },
        { code: 'vi', name: 'Tiếng Việt', alt: ['vie', 'vietnamese', 'tiếng việt', 'tieng viet'] },
        { code: 'ar', name: 'العربية',   alt: ['ara', 'arabic', 'العربية'] },
        { code: 'tr', name: 'Türkçe',     alt: ['tur', 'turkish', 'türkçe', 'turkce'] },
        { code: 'pl', name: 'Polski',     alt: ['pol', 'polish', 'polski'] },
        { code: 'sv', name: 'Svenska',    alt: ['swe', 'swedish', 'svenska'] },
        { code: 'no', name: 'Norsk',      alt: ['nor', 'nob', 'norwegian', 'norsk'] },
        { code: 'da', name: 'Dansk',      alt: ['dan', 'danish', 'dansk'] },
        { code: 'fi', name: 'Suomi',      alt: ['fin', 'finnish', 'suomi'] }
    ];

    function entryFor(code) {
        for (var i = 0; i < langs.length; i++) if (langs[i].code === code) return langs[i];
        return null;
    }

    /* Every spelling that identifies `code`, lower-cased: the code itself,
     * its ISO 639-2 forms, the English name and the endonym. */
    function tagsFor(code) {
        var c = String(code || '').toLowerCase();
        var e = entryFor(c);
        var out = [c];
        if (e) {
            for (var i = 0; i < e.alt.length; i++) out.push(e.alt[i]);
            var n = e.name.toLowerCase();
            if (out.indexOf(n) < 0) out.push(n);
        }
        return out;
    }

    function esc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
    /* Whole-"word" test that also works for names with no spaces — track
     * labels are routinely filename-ish ("Show.S01E02.vi.srt"), so anything
     * that isn't a latin letter or digit counts as a separator. */
    function hasWord(hay, word) {
        return new RegExp('(^|[^a-z0-9])' + esc(word) + '($|[^a-z0-9])', 'i').test(hay);
    }

    /* How well a track matches a language preference: 0 = no match, 100 =
     * the track's own language tag says so.  Shared by the audio picker and
     * the subtitle picker in app.js so both honour the same spellings. */
    function matchScore(pref, lang, name) {
        var want = String(pref || '').toLowerCase();
        if (!want || want === 'off') return 0;
        var tags = tagsFor(want);
        var nm   = String(name || '').toLowerCase();

        // 1. The container's own language tag ('vie', 'vi', 'vi-VN').
        var base = String(lang || '').toLowerCase().split(/[-_]/)[0];
        if (base) {
            if (tags.indexOf(base) >= 0) return 100;
            if (base.length >= 2 &&
                (base.indexOf(want) === 0 || want.indexOf(base) === 0)) return 90;
        }
        if (!nm) return 0;

        // 2. A code in brackets, the muxer convention: "Subtitle [vie]".
        for (var i = 0; i < tags.length; i++)
            if (nm.indexOf('[' + tags[i] + ']') >= 0 ||
                nm.indexOf('(' + tags[i] + ')') >= 0) return 80;

        // 3. A spelled-out name anywhere in the label: "Vietnamese SDH".
        //    Two-letter latin tags are held back for step 4 (too collision-
        //    prone), but a short non-ascii endonym like "中文" is unambiguous.
        for (var j = 0; j < tags.length; j++)
            if ((tags[j].length >= 3 || /[^\x00-\x7f]/.test(tags[j])) &&
                hasWord(nm, tags[j])) return 60;

        // 4. The bare two-letter code, but only as its own word — a loose
        //    substring here is what made 'vi' match "Movie".
        if (want.length === 2 && hasWord(nm, want)) return 50;
        return 0;
    }

    return {
        forAudio:    function () { return langs; },
        forSubtitle: function () { return [{ code: 'off', name: 'Off (no subtitles)' }].concat(langs); },
        matchScore:  matchScore,
        nameFor:     function (code) {
            if (code === 'off') return 'Off';
            var e = entryFor(code);
            return e ? e.name : (code || 'Auto');
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


/* Video aspect modes — how the picture is fitted to the screen.
 *
 * There are three, and the reason there aren't more is worth writing down:
 * two different kinds of "black bars" exist, and only one of them is the
 * player's to fix.
 *
 *   1. The frame really is wider than the screen (a 2.39:1 frame on a 16:9
 *      panel).  The firmware letterboxes it, and 'fill' — AVPlay's
 *      CROPPED_FULL, CSS object-fit:cover — scales the picture until it
 *      covers the screen and crops the sides instead, aspect preserved.
 *
 *   2. The bars are encoded INTO the frames — a 2.39:1 film muxed as 16:9,
 *      which is what most streaming rips are.  As far as the firmware is
 *      concerned the frame already matches the panel, so LETTER_BOX,
 *      CROPPED_FULL and FULL_SCREEN all paint the same picture and none of
 *      them can change anything.  Cropping bars like that means magnifying
 *      past the frame edge: a display rect bigger than the screen and
 *      centred on it.  A centred oversized rect has a negative origin, and
 *      setDisplayRect "throws InvalidValuesError if any input parameter
 *      contains a negative value" — Samsung's own AVPlay reference.  The
 *      picture is always centred in the rect it is handed, so no legal rect
 *      can push the top bar off the top of the screen, and AVPlay exposes no
 *      source-crop or ROI call to do it another way.  Zoom and crop modes
 *      were built and tried on two sets; neither moved a pixel.  They are
 *      gone, and the player now says why rather than offering a mode that
 *      cannot work.
 *
 * 'stretch' is the blunt instrument — fills the screen by distorting the
 * picture.  Some users prefer it, so it stays on the list, labelled.
 *
 * `av` values are Samsung AVPlay display methods; unsupported ones throw on
 * older firmware, and player.js falls back to LETTER_BOX when they do. */
var AspectRatio = (function () {
    var MODES = [
        { code: 'fit',     name: 'Fit screen (keep black bars)',    short: 'Fit',
          av: 'PLAYER_DISPLAY_MODE_LETTER_BOX',   fit: 'contain' },
        { code: 'fill',    name: 'Fill screen (crop the sides)',    short: 'Fill',
          av: 'PLAYER_DISPLAY_MODE_CROPPED_FULL', fit: 'cover' },
        // 'Wide' is the label TVs traditionally put on a stretched 16:9
        // picture, and unlike 'Stretch' it fits inside the round OSD button.
        { code: 'stretch', name: 'Stretch (fills, distorts shape)', short: 'Wide',
          av: 'PLAYER_DISPLAY_MODE_FULL_SCREEN',  fit: 'fill' }
    ];

    function isKnown(code) {
        for (var i = 0; i < MODES.length; i++) if (MODES[i].code === code) return true;
        return false;
    }
    function find(code) {
        for (var i = 0; i < MODES.length; i++) if (MODES[i].code === code) return MODES[i];
        return MODES[0];
    }
    /* The mode currently in force, resolved from Settings. */
    function current() {
        if (typeof Settings === 'undefined') return MODES[0];
        return find(Settings.get('aspectMode'));
    }

    /* Next mode in the list — the OSD button cycles rather than opening a
     * picker when the user just wants to flick through them. */
    function next(code) {
        for (var i = 0; i < MODES.length; i++)
            if (MODES[i].code === code) return MODES[(i + 1) % MODES.length].code;
        return MODES[0].code;
    }

    return {
        forList: function () { return MODES; },
        find:    find,
        isKnown: isKnown,
        current: current,
        next:    next,
        nameFor:  function (c) { return find(c).name; },
        shortFor: function (c) { return find(c).short; }
    };
})();

// Ignored by the Tizen/browser build; lets Node tests require these helpers.
if (typeof module !== 'undefined' && module.exports)
    module.exports = {
        Settings:      Settings,
        LanguageList:  LanguageList,
        SubtitleStyle: SubtitleStyle,
        AspectRatio:   AspectRatio
    };

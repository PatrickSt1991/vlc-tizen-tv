/* Player wrapper — AVPlay first, HTML5 as fallback for local files.
 *
 * Backend selection:
 *   - All URLs (local + network) try Samsung AVPlay first.  AVPlay sees
 *     embedded audio + subtitle tracks in MKV / MP4 / TS / etc., supports
 *     HLS / DASH / RTSP, and uses the same hardware decoder.
 *   - For local files, we wire a fallback callback into avOpen().  If
 *     AVPlay can't open the file, prepareAsync rejects, the runtime
 *     listener fires onerror, or AVPlay reports PLAYING but never decodes
 *     a frame within 8 s, we silently swap to the HTML5 <video> element
 *     and replay from there.  Net result: every file that worked in HTML5
 *     before still works (just with an 8 s delay when AVPlay can't handle
 *     it), and any container AVPlay can decode gains track-switching for
 *     free.
 *   - Path normalization: AVPlay rejects `file://` URIs and wants a raw
 *     absolute filesystem path, percent-decoded.  Handled by avplayUrl().
 */

var Player = (function () {

    /* ── Backend dispatch ──────────────────────────────────────────────── */
    var BACKEND_NONE   = 'none';
    var BACKEND_AVPLAY = 'avplay';
    var BACKEND_HTML5  = 'html5';
    var backend = BACKEND_NONE;

    function isLocalUrl(url) {
        return /^file:\/\//.test(url) || /^\//.test(url);
    }
    function isMkvUrl(url) {
        var lower = String(url || '').toLowerCase().split('?')[0];
        return /\.mkv$/.test(lower);
    }
    /* Try AVPlay first for everything.  Local files get a fallback to
     * HTML5 wired up in open() so we degrade gracefully on containers
     * AVPlay can't decode. */
    function pickBackend(url) {
        return BACKEND_AVPLAY;
    }

    /* AVPlay on Tizen 5.0 rejects `file://` URIs — it wants a raw
     * absolute filesystem path, percent-decoded.  Network URLs pass
     * through untouched.  Browser.js currently hands us paths via
     * Tizen's File.toURI(), which yields `file:///opt/media/...`, so
     * we normalize here in one place. */
    function avplayUrl(url) {
        var s = String(url || '');
        if (s.indexOf('file://') === 0) {
            s = s.slice(7);
            try { s = decodeURIComponent(s); } catch (e) {}
        }
        return s;
    }

    /* ── Listener fanout ───────────────────────────────────────────────── */
    var listeners = {
        onstatechange: null,
        onerror:       null,
        onbuffering:   null,
        onprogress:    null,
        oncomplete:    null
    };
    function setListener(name, fn) { if (name in listeners) listeners[name] = fn; }
    function emit(name) {
        if (listeners[name]) listeners[name].apply(null, [].slice.call(arguments, 1));
    }

    /* ── AVPlay backend ────────────────────────────────────────────────── */
    var avplay = null;
    function av() {
        if (avplay) return avplay;
        if (typeof webapis !== 'undefined' && webapis.avplay) avplay = webapis.avplay;
        return avplay;
    }

    function avSetDisplayRect() {
        try {
            var w = window.innerWidth  || screen.width  || 1920;
            var h = window.innerHeight || screen.height || 1080;
            av().setDisplayRect(0, 0, w, h);
            if (typeof Debug !== 'undefined') Debug.player('AV setDisplayRect ' + w + 'x' + h);
        } catch (e) {
            if (typeof Debug !== 'undefined') Debug.warn('AV setDisplayRect: ' + e.message);
        }
    }
    function avSetDisplayMethod() {
        try {
            av().setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX');
        } catch (e) {
            if (typeof Debug !== 'undefined') Debug.warn('AV setDisplayMethod: ' + e.message);
        }
    }

    /* AVPlay subtitle painter — onsubtitlechange(duration, text) hands us
     * the cue text + how long to show it.  We strip HTML / ASS overrides,
     * decode common entities and paint into #subtitle-overlay. */
    var subClearTimer = null;
    function subEl() { return document.getElementById('subtitle-overlay'); }
    function showSubtitleText(text, durationMs) {
        var el = subEl();
        if (!el) return;
        var s = String(text == null ? '' : text)
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<[^>]+>/g, '')
            .replace(/\{\\[^}]*\}/g, '')                 // ASS override tags
            .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
            .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
            .trim();
        if (!s) { hideSubtitleText(); return; }
        el.textContent = s;
        el.classList.remove('hidden');
        clearTimeout(subClearTimer);

        /* AVPlay's `duration` is wildly unreliable.  Observed values:
         *   0           — used as a "clear previous cue" signal
         *   ~1000-8000  — a sane per-cue duration in ms
         *   3,500,000   — bogus "rest of stream" value (would freeze
         *                 the overlay for 58 minutes)
         *
         * Treat 0 as "show until next cue" (no timer).
         * Treat huge values the same way — assume the next SUB cb will
         * replace this cue, and cap at 8 s as a safety net so a single
         * cue can't stay stuck if AVPlay never fires again. */
        var d = (typeof durationMs === 'number' && durationMs > 0)
                  ? durationMs : 0;
        if (d > 30000) d = 8000;        // bogus: cap at 8 s safety net
        if (d > 0) {
            subClearTimer = setTimeout(hideSubtitleText, d);
        }
    }
    function hideSubtitleText() {
        clearTimeout(subClearTimer);
        var el = subEl();
        if (el) { el.textContent = ''; el.classList.add('hidden'); }
    }

    var avPollTimer = null;
    var avLastDebugT = 0, avLastDebugPos = 0;
    var avStuckChecks = 0;          // consecutive 500ms polls with no advance
    var AV_STUCK_THRESHOLD = 10;    // 10 × 500ms = 5s of frozen PLAYING → bail
                                    // (was 8s; reduced since AVPlay tries every
                                    //  local file now, not just MKV)
    function avStartPolling(onFallback) {
        avStopPolling();
        avLastDebugT = 0; avLastDebugPos = 0; avStuckChecks = 0;
        var fallbackFired = false;
        avPollTimer = setInterval(function () {
            try {
                var s = av().getState();
                var t = av().getCurrentTime();
                var d = av().getDuration();
                emit('onprogress', { state: s, time: t, duration: d });
                var now = Date.now();
                if (typeof Debug !== 'undefined' && now - avLastDebugT > 5000) {
                    var stuck = (s === 'PLAYING' && t === avLastDebugPos) ?
                        ' (NOT ADVANCING — unsupported codec)' : '';
                    Debug.player('AV progress state=' + s + ' time=' + t + 'ms dur=' + d + 'ms' + stuck);
                    avLastDebugT = now; avLastDebugPos = t;
                }
                /* Watchdog: AVPlay sometimes reports PLAYING for a local
                 * file but never actually decodes a frame.  After ~8s of
                 * t==0 while state=PLAYING, give up and let the caller
                 * fall back to the HTML5 backend. */
                if (onFallback && !fallbackFired && s === 'PLAYING' && t === 0) {
                    avStuckChecks++;
                    if (avStuckChecks >= AV_STUCK_THRESHOLD) {
                        fallbackFired = true;
                        if (typeof Debug !== 'undefined')
                            Debug.error('AV stuck at t=0 for ' + (AV_STUCK_THRESHOLD*500) + 'ms — falling back');
                        avStopPolling();
                        onFallback('no decode progress');
                    }
                } else if (t > 0) {
                    avStuckChecks = 0;
                }
            } catch (e) {}
        }, 500);
    }
    function avStopPolling() {
        if (avPollTimer) { clearInterval(avPollTimer); avPollTimer = null; }
    }

    function avOpen(url, onFallback) {
        if (!av()) {
            if (onFallback) { onFallback('AVPlay API not available'); return; }
            emit('onerror', 'AVPlay API not available'); return;
        }
        var path = avplayUrl(url);
        if (typeof Debug !== 'undefined') Debug.player('AV open path=' + path);

        try { av().close(); } catch (e) {}
        try {
            av().open(path);
            if (typeof Debug !== 'undefined') Debug.player('AV open() returned');
        } catch (e) {
            if (typeof Debug !== 'undefined') Debug.error('AV open() threw: ' + (e.message || e));
            if (onFallback) { onFallback('open: ' + (e.message || e)); return; }
            emit('onerror', 'AVPlay open(): ' + (e.message || e));
            return;
        }
        var subListener = function (duration, text, type, attr) {
            if (typeof Debug !== 'undefined')
                Debug.player('SUB cb dur=' + duration + ' type=' + type +
                             ' text=' + JSON.stringify(text || '').slice(0, 80));
            showSubtitleText(text, duration);
        };

        try {
            av().setListener({
                onbufferingstart:    function () { emit('onbuffering', true); },
                onbufferingcomplete: function () { emit('onbuffering', false); },
                onstreamcompleted:   function () { emit('oncomplete'); },
                onerror:             function (e) {
                    if (onFallback) { onFallback('runtime: ' + (e && e.message || e)); return; }
                    emit('onerror', e);
                },
                onerrormsg:          function (c, m) {
                    if (onFallback) { onFallback('runtime: ' + (m || c)); return; }
                    emit('onerror', m || c);
                },
                onsubtitlechange: subListener,
                /* Some firmwares use the alternate name "onSubtitleEvent". */
                onSubtitleEvent:  subListener,
                /* Some firmwares deliver text subs through onevent with
                 * eventType === 'PLAYER_MSG_FRAGMENT_INFO' or 'SUBTITLE'. */
                onevent: function (eventType, eventData) {
                    if (typeof Debug !== 'undefined')
                        Debug.player('AV onevent ' + eventType + ' ' +
                                     (typeof eventData === 'string' ? eventData.slice(0, 80) :
                                      JSON.stringify(eventData || '').slice(0, 80)));
                    if (/sub/i.test(String(eventType)) && eventData) {
                        showSubtitleText(eventData, 5000);
                    }
                }
            });
        } catch (e) {}

        /* Also assign the subtitle callback directly on the av object — some
         * older Samsung TV firmwares require this older pattern in addition
         * to setListener. Harmless if the firmware ignores it. */
        try { av().onsubtitlechange = subListener; } catch (e) {}
        try { av().onSubtitleEvent  = subListener; } catch (e) {}

        try {
            av().prepareAsync(
                function () {
                    avSetDisplayRect();
                    avSetDisplayMethod();
                    try { av().play(); } catch (e) {}
                    avStartPolling(onFallback);
                    emit('onstatechange', 'playing');
                },
                function (err) {
                    var msg = err && err.message ? err.message : err;
                    if (typeof Debug !== 'undefined') Debug.error('AV prepareAsync failed: ' + msg);
                    if (onFallback) { onFallback('prepare: ' + msg); return; }
                    emit('onerror', 'prepare failed: ' + msg);
                }
            );
        } catch (e) {
            try { av().prepare(); av().play(); avStartPolling(onFallback); emit('onstatechange', 'playing'); }
            catch (e2) {
                if (typeof Debug !== 'undefined') Debug.error('AV prepare() threw: ' + (e2.message || e2));
                if (onFallback) { onFallback('prepare: ' + (e2.message || e2)); return; }
                emit('onerror', 'prepare failed: ' + (e2.message || e2));
            }
        }
    }

    /* ── HTML5 backend ────────────────────────────────────────────────── */
    var h5 = null;
    function h5el() {
        if (!h5) h5 = document.getElementById('html5-video');
        return h5;
    }
    var h5OpenWatchdog = null;
    var h5Subtitles = [];   // [{ name, lang, uri, file, ext }] passed in opts.subtitles
    function h5Open(url, opts) {
        var v = h5el();
        v.style.display = 'block';
        h5Subtitles = (opts && opts.subtitles) ? opts.subtitles.slice() : [];

        while (v.firstChild) v.removeChild(v.firstChild);
        var lower = String(url).toLowerCase().split('?')[0];
        var isMkv = /\.mkv$/.test(lower);
        var sourceType = null;
        if (isMkv || /\.webm$/.test(lower))                    sourceType = 'video/webm';
        else if (/\.mp4$/.test(lower) || /\.m4v$/.test(lower)) sourceType = 'video/mp4';
        else if (/\.mov$/.test(lower))                         sourceType = 'video/mp4';
        else if (/\.ogg$/.test(lower) || /\.ogv$/.test(lower)) sourceType = 'video/ogg';

        if (sourceType) {
            var source = document.createElement('source');
            source.src = url;
            source.type = sourceType;
            v.appendChild(source);
            if (typeof Debug !== 'undefined') Debug.player('H5 source url=' + url + ' type=' + sourceType);
        } else {
            v.src = url;
        }

        /* HTML5 <video> on Tizen 5.0 chromium silently swallows unsupported
         * formats — no `error` event, no `loadedmetadata`, just hangs.  Bail
         * out after 6s with a clear message instead of waiting for the global
         * watchdog. */
        clearTimeout(h5OpenWatchdog);
        h5OpenWatchdog = setTimeout(function () {
            if (!v.duration || v.duration === 0 || isNaN(v.duration)) {
                if (typeof Debug !== 'undefined')
                    Debug.error('H5 timeout: no metadata after 6s' + (isMkv ? ' (MKV)' : ''));
                if (isMkv) {
                    emit('onerror', 'MKV not supported by this TV');
                } else {
                    emit('onerror', 'HTML5 video: file format not supported');
                }
            }
        }, 6000);

        v.onloadedmetadata = function () {
            clearTimeout(h5OpenWatchdog);
            if (typeof Debug !== 'undefined') Debug.player('H5 metadata loaded; duration=' + v.duration + 's');
        };
        v.oncanplay = function () {
            if (typeof Debug !== 'undefined') Debug.player('H5 canplay');
            try { v.play(); } catch (e) {}
        };
        v.onplaying = function () {
            if (typeof Debug !== 'undefined') Debug.player('H5 playing');
            emit('onstatechange', 'playing');
        };
        v.onpause = function () {
            if (typeof Debug !== 'undefined') Debug.player('H5 paused');
            emit('onstatechange', 'paused');
        };
        v.onwaiting = function () { emit('onbuffering', true); };
        v.onstalled = function () { emit('onbuffering', true); };
        v.onplaying = function () { emit('onbuffering', false); emit('onstatechange', 'playing'); };
        v.ontimeupdate = function () {
            emit('onprogress', { state: 'PLAYING', time: (v.currentTime||0) * 1000, duration: (v.duration||0) * 1000 });
        };
        v.onended = function () {
            if (typeof Debug !== 'undefined') Debug.player('H5 ended');
            emit('oncomplete');
        };
        v.onerror = function () {
            var err = v.error;
            var code = err ? err.code : 0;
            var msg = ({1:'aborted', 2:'network error', 3:'decode error', 4:'unsupported source'})[code] || ('code ' + code);
            if (typeof Debug !== 'undefined') Debug.error('H5 error: ' + msg);
            emit('onerror', 'HTML5 video: ' + msg);
        };
        v.load();
    }

    /* ── Public API ───────────────────────────────────────────────────── */

    /* Sniff stream type from URL — informational, used to log + decide backend. */
    function sniffStreamType(url) {
        var lower = String(url).toLowerCase().split('?')[0];
        if (lower.indexOf('rtsp://') === 0)  return 'RTSP';
        if (lower.indexOf('rtmp://') === 0)  return 'RTMP';
        if (lower.indexOf('mms://')  === 0)  return 'MMS';
        if (/\.m3u8?$/.test(lower))          return 'HLS';
        if (/\.mpd$/.test(lower))            return 'DASH';
        if (/\.ism\/?(?:Manifest)?$/.test(lower)) return 'SMOOTH';
        if (isLocalUrl(url))                 return 'LOCAL';
        return 'PROGRESSIVE';
    }

    function open(url, opts) {
        opts = opts || {};
        backend = pickBackend(url);
        var streamType = sniffStreamType(url);
        if (typeof Debug !== 'undefined') Debug.player('open url=' + url + ' (type=' + streamType + ', backend=' + backend + ')');

        if (backend === BACKEND_HTML5) {
            // Hide AVPlay's object so the HTML5 video element is the only thing rendering
            var po = document.getElementById('player-object');
            if (po) po.style.display = 'none';
            h5Open(url, opts);
        } else {
            var v = h5el();
            if (v) v.style.display = 'none';
            var po2 = document.getElementById('player-object');
            if (po2) po2.style.display = 'block';

            // For local files routed to AVPlay (currently: .mkv), supply a
            // fallback so we degrade gracefully to HTML5 if AVPlay can't
            // open the path or never actually decodes. Network URLs get
            // no fallback — they surface errors normally.
            if (isLocalUrl(url)) {
                avOpen(url, function (reason) {
                    if (typeof Debug !== 'undefined')
                        Debug.player('AV local-file fallback → HTML5: ' + reason);
                    try { if (av()) av().close(); } catch (e) {}
                    avStopPolling();
                    if (po2) po2.style.display = 'none';
                    backend = BACKEND_HTML5;
                    if (v) v.style.display = 'block';
                    h5Open(url, opts);
                });
            } else {
                avOpen(url);
            }
        }
    }

    function play() {
        if (backend === BACKEND_HTML5) { try { h5el().play(); } catch (e) {} emit('onstatechange', 'playing'); }
        else if (backend === BACKEND_AVPLAY) { try { av().play(); } catch (e) {} emit('onstatechange', 'playing'); }
    }
    function pause() {
        if (backend === BACKEND_HTML5) { try { h5el().pause(); } catch (e) {} emit('onstatechange', 'paused'); }
        else if (backend === BACKEND_AVPLAY) { try { av().pause(); } catch (e) {} emit('onstatechange', 'paused'); }
    }
    function togglePause() {
        var st = state();
        if (st === 'PLAYING') pause();
        else                  play();
    }
    function stop() {
        clearTimeout(h5OpenWatchdog);
        hideSubtitleText();
        // Always fully tear down BOTH backends — some firmwares leave the
        // hidden one alive (auto-replaying audio on view switch).
        var v = h5el();
        if (v) {
            try { v.pause(); } catch (e) {}
            try { v.currentTime = 0; } catch (e) {}
            try { v.removeAttribute('src'); } catch (e) {}
            // Detach any <track>/<source> children
            while (v.firstChild) v.removeChild(v.firstChild);
            try { v.load(); } catch (e) {}
            v.style.display = 'none';
        }
        avStopPolling();
        try { if (av()) av().stop();  } catch (e) {}
        try { if (av()) av().close(); } catch (e) {}

        backend = BACKEND_NONE;
        h5Subtitles = [];
        emit('onstatechange', 'stopped');
    }
    function seekRel(deltaMs) {
        if (backend === BACKEND_HTML5) {
            var v = h5el();
            try {
                var t = v.currentTime + (deltaMs / 1000);
                v.currentTime = Math.max(0, Math.min(v.duration ? v.duration - 0.5 : t, t));
            } catch (e) {}
        } else if (backend === BACKEND_AVPLAY) {
            try {
                var ct = av().getCurrentTime();
                var d  = av().getDuration();
                var to = Math.max(0, Math.min(d ? d - 1000 : ct + deltaMs, ct + deltaMs));
                av().seekTo(to);
            } catch (e) {}
        }
    }
    function seekTo(ms) {
        if (backend === BACKEND_HTML5) {
            try { h5el().currentTime = Math.max(0, ms / 1000); } catch (e) {}
        } else if (backend === BACKEND_AVPLAY) {
            try { av().seekTo(Math.max(0, ms)); } catch (e) {}
        }
    }
    function currentTime() {
        if (backend === BACKEND_HTML5)    return (h5el().currentTime || 0) * 1000;
        if (backend === BACKEND_AVPLAY)   { try { return av().getCurrentTime(); } catch (e) { return 0; } }
        return 0;
    }
    function duration() {
        if (backend === BACKEND_HTML5)    return (h5el().duration || 0) * 1000;
        if (backend === BACKEND_AVPLAY)   { try { return av().getDuration(); } catch (e) { return 0; } }
        return 0;
    }
    function state() {
        if (backend === BACKEND_HTML5) {
            var v = h5el();
            if (v.paused)  return 'PAUSED';
            if (v.ended)   return 'IDLE';
            return v.readyState >= 3 ? 'PLAYING' : 'READY';
        }
        if (backend === BACKEND_AVPLAY) { try { return av().getState(); } catch (e) { return 'NONE'; } }
        return 'NONE';
    }
    function setDisplayRect() {
        if (backend === BACKEND_AVPLAY) avSetDisplayRect();
    }

    /* AVPlay's extra_info field is a JSON string with fields like
     *   { "language":"eng", "channels":2, "fourCC":"AAC", ... }
     * for audio, and similar for subtitles.  Older firmwares hand back
     * a plain string instead.  Return a {label, lang} pair either way. */
    function parseAvExtraInfo(raw) {
        if (!raw) return { label: '', lang: '' };
        var s = String(raw).trim();
        var obj = null;
        if (s.charAt(0) === '{') {
            try { obj = JSON.parse(s); } catch (e) {}
        }
        if (!obj) {
            // Not JSON — use as-is, and look for a 3-letter ISO code in it
            var m = s.match(/\b([a-z]{2,3})\b/i);
            return { label: s, lang: m ? m[1].toLowerCase() : '' };
        }
        var lang = (obj.language || obj.lang || '').toString().toLowerCase();
        var parts = [];
        if (lang) parts.push(lang.toUpperCase());
        if (obj.fourCC)   parts.push(obj.fourCC);
        if (obj.channels) parts.push(obj.channels + 'ch');
        return { label: parts.join(' · ') || s, lang: lang };
    }

    /* ── Track info ─────────────────────────────────────────────────────
     *
     * For AVPlay (HTTP streams): native enumeration via getTotalTrackInfo().
     * For HTML5 (local files):
     *   - audio:    video.audioTracks (when present — chromium 47 has it,
     *               newer chromium dropped it; Tizen 5.0 is the right vintage).
     *   - subtitle: the sibling subtitle files passed in opts.subtitles, plus
     *               any embedded textTracks the video exposes. */
    function getTracks() {
        var out = { audio: [], subtitle: [{ index: -1, name: 'Off', off: true, active: false }] };

        if (backend === BACKEND_AVPLAY) {
            try {
                var info = av().getTotalTrackInfo();
                for (var i = 0; i < info.length; i++) {
                    var t = info[i];
                    var parsed = parseAvExtraInfo(t.extra_info);
                    // VIDEO tracks: do not show in the picker.  AVPlay also
                    // returns these from getTotalTrackInfo and we don't want
                    // an entry like "h264" misclassified as a subtitle.
                    if (t.type === 'VIDEO') continue;
                    if (t.type === 'AUDIO') {
                        out.audio.push({
                            index: t.index,
                            name:  parsed.label || ('Audio ' + t.index),
                            lang:  parsed.lang || '',
                            type:  'AVPLAY'
                        });
                    } else if (t.type === 'TEXT' || t.type === 'SUBTITLE') {
                        out.subtitle.push({
                            index: t.index,
                            name:  parsed.label || ('Subtitle ' + t.index),
                            lang:  parsed.lang || '',
                            type:  'AVPLAY'
                        });
                    }
                    // Anything else (DRM, METADATA, etc.) is ignored.
                }
            } catch (e) {}
            return out;
        }

        if (backend === BACKEND_HTML5) {
            var v = h5el();

            // Audio tracks — only on browsers that expose audioTracks
            if (v.audioTracks && v.audioTracks.length) {
                for (var j = 0; j < v.audioTracks.length; j++) {
                    var at = v.audioTracks[j];
                    out.audio.push({
                        index:  j,
                        name:   at.label || at.language || ('Audio ' + j),
                        type:   'HTML5_AUDIO',
                        active: !!at.enabled
                    });
                }
            }

            // External sibling subtitles
            for (var k = 0; k < h5Subtitles.length; k++) {
                var s = h5Subtitles[k];
                out.subtitle.push({
                    index:  k,
                    name:   (s.lang ? '[' + s.lang.toUpperCase() + '] ' : '') + s.name,
                    type:   'HTML5_EXTERNAL',
                    active: false  // set when activated
                });
            }

            // Currently-attached <track> elements — mark the active one
            if (v.textTracks && v.textTracks.length) {
                for (var t = 0; t < v.textTracks.length; t++) {
                    if (v.textTracks[t].mode === 'showing' && out.subtitle[t + 1]) {
                        out.subtitle[t + 1].active = true;
                        out.subtitle[0].active = false;
                    }
                }
                if (!out.subtitle.slice(1).some(function (x) { return x.active; })) {
                    out.subtitle[0].active = true;
                }
            } else {
                out.subtitle[0].active = true;
            }
        }

        return out;
    }

    function setAudioTrack(index) {
        if (backend === BACKEND_AVPLAY) {
            try { av().setSelectTrack('AUDIO', index); } catch (e) {}
        } else if (backend === BACKEND_HTML5) {
            var v = h5el();
            if (v.audioTracks) {
                for (var i = 0; i < v.audioTracks.length; i++)
                    v.audioTracks[i].enabled = (i === index);
            }
        }
    }

    function setSubtitleTrack(index) {
        if (backend === BACKEND_AVPLAY) {
            // Clear the on-screen overlay before switching so an old cue
            // doesn't linger past the change.
            hideSubtitleText();
            if (index < 0 || index === undefined) {
                // "Off" — try disabling via the firmware's preferred API.
                try { av().setSilentSubtitle(true); } catch (e) {}
                return;
            }
            try { av().setSilentSubtitle(false); } catch (e) {}
            try { av().setSelectTrack('TEXT', index); }
            catch (e) { try { av().setSelectTrack('SUBTITLE', index); } catch (e2) {} }
            return;
        }
        if (backend !== BACKEND_HTML5) return;

        var v = h5el();
        // "Off" — disable every existing textTrack
        if (index < 0 || index === undefined) {
            if (v.textTracks) for (var i = 0; i < v.textTracks.length; i++) v.textTracks[i].mode = 'disabled';
            return;
        }
        var sub = h5Subtitles[index];
        if (!sub) return;

        // Disable any existing tracks then attach the requested one
        if (v.textTracks) for (var j = 0; j < v.textTracks.length; j++) v.textTracks[j].mode = 'disabled';

        // Load via Tizen filesystem, convert SRT→VTT if needed, attach as Blob URL <track>
        if (sub._attached) {
            sub._track.mode = 'showing';
            return;
        }
        loadSubtitleAsVTT(sub, function (err, vttUrl) {
            if (err) { if (typeof Debug !== 'undefined') Debug.error('subtitle load: ' + err.message); return; }
            // Remove any previous track element
            var existing = v.querySelectorAll('track');
            for (var i = existing.length - 1; i >= 0; i--) v.removeChild(existing[i]);

            var track = document.createElement('track');
            track.kind    = 'subtitles';
            track.label   = (sub.lang || 'subs').toUpperCase();
            track.srclang = sub.lang || 'en';
            track.src     = vttUrl;
            track.default = true;
            v.appendChild(track);

            // Showing mode must be set after attachment
            setTimeout(function () {
                if (v.textTracks && v.textTracks.length) {
                    v.textTracks[v.textTracks.length - 1].mode = 'showing';
                }
            }, 100);

            sub._attached = true;
            sub._track    = v.textTracks[v.textTracks.length - 1];
        });
    }

    /* Convert a subtitle file (.vtt / .srt / .ass / .ssa / .smi / .sami) to
     * a WebVTT Blob URL the <track> element can load.  All converters live
     * in this file — no external deps. */
    function loadSubtitleAsVTT(sub, cb) {
        if (typeof Browser === 'undefined' || !Browser.readSubtitleText) {
            cb(new Error('Browser.readSubtitleText not available'));
            return;
        }
        Browser.readSubtitleText(sub, function (err, text) {
            if (err) { cb(err); return; }
            var vtt;
            switch (sub.ext) {
                case 'vtt':                 vtt = text;            break;
                case 'srt':                 vtt = srtToVtt(text);  break;
                case 'ass':
                case 'ssa':                 vtt = assToVtt(text);  break;
                case 'smi':
                case 'sami':                vtt = smiToVtt(text);  break;
                default:
                    cb(new Error('unsupported subtitle ext: ' + sub.ext));
                    return;
            }
            try {
                var blob = new Blob([vtt], { type: 'text/vtt' });
                cb(null, URL.createObjectURL(blob));
            } catch (e) { cb(e); }
        });
    }

    /* SRT → VTT: re-stamp the comma-decimal timecodes to dot-decimal, strip
     * numeric cue indices.  Header is the literal "WEBVTT". */
    function srtToVtt(srt) {
        var lines = srt.replace(/\r/g, '').split('\n');
        var out = ['WEBVTT', ''];
        for (var i = 0; i < lines.length; i++) {
            var l = lines[i];
            if (/^\d+\s*$/.test(l)) continue;                   // numeric index
            l = l.replace(/(\d\d:\d\d:\d\d),(\d{3})/g, '$1.$2'); // commas → dots
            out.push(l);
        }
        return out.join('\n');
    }

    /* ASS / SSA → VTT.  Drops styling, layers, fonts, override tags
     * ({\an8} etc.) — keeps only the dialogue text and timestamps.  ASS
     * dialogue lines:
     *   Dialogue: Layer, Start, End, Style, Name, ML, MR, MV, Effect, Text
     * Times look like "H:MM:SS.cc" (centiseconds). */
    function assToVtt(ass) {
        var lines = ass.replace(/\r/g, '').split('\n');
        var out = ['WEBVTT', ''];
        var fmt = null;
        var inEvents = false;

        for (var i = 0; i < lines.length; i++) {
            var raw = lines[i];
            var l = raw.trim();
            if (l.charAt(0) === '[' && l.charAt(l.length - 1) === ']') {
                inEvents = (l.toLowerCase() === '[events]');
                continue;
            }
            if (!inEvents) continue;

            if (l.toLowerCase().indexOf('format:') === 0) {
                fmt = l.substring(7).split(',').map(function (s) { return s.trim().toLowerCase(); });
                continue;
            }
            if (l.toLowerCase().indexOf('dialogue:') !== 0 || !fmt) continue;

            // Split into the format fields, keeping the rest as the Text field
            var rest = l.substring(9).trim();
            var parts = [];
            var idx = 0;
            for (var k = 0; k < fmt.length - 1; k++) {
                var comma = rest.indexOf(',', idx);
                if (comma < 0) break;
                parts.push(rest.substring(idx, comma));
                idx = comma + 1;
            }
            parts.push(rest.substring(idx));

            var startIdx = fmt.indexOf('start');
            var endIdx   = fmt.indexOf('end');
            var textIdx  = fmt.indexOf('text');
            if (startIdx < 0 || endIdx < 0 || textIdx < 0) continue;

            var start = assTimeToVtt(parts[startIdx].trim());
            var end   = assTimeToVtt(parts[endIdx].trim());
            var text  = (parts[textIdx] || '')
                .replace(/\{[^}]*\}/g, '')   // override tags {\b1} etc.
                .replace(/\\N/g, '\n')       // hard line break
                .replace(/\\n/g, '\n')       // soft line break
                .replace(/\\h/g, ' ')        // hard space
                .replace(/<[^>]+>/g, '');    // any HTML

            if (!start || !end || !text.trim()) continue;
            out.push(start + ' --> ' + end);
            out.push(text);
            out.push('');
        }
        return out.join('\n');
    }
    function assTimeToVtt(t) {
        // H:MM:SS.cc  →  HH:MM:SS.mmm   (centiseconds → milliseconds)
        var m = /^(\d+):(\d{2}):(\d{2})[.,](\d{2,3})$/.exec(t);
        if (!m) return null;
        var h = parseInt(m[1], 10);
        var ms = m[4].length === 2 ? m[4] + '0' : m[4];
        return (h < 10 ? '0' + h : h) + ':' + m[2] + ':' + m[3] + '.' + ms;
    }

    /* SMI / SAMI → VTT.  SAMI is HTML-ish; each <SYNC Start=N> sets the
     * start of a cue in milliseconds.  The cue's text continues until the
     * next <SYNC>.  '&nbsp;' alone means "blank out the previous cue". */
    function smiToVtt(smi) {
        var out = ['WEBVTT', ''];
        var re = /<sync\s+start\s*=\s*["']?(\d+)["']?[^>]*>([\s\S]*?)(?=<sync\b|<\/body>|$)/gi;
        var cues = [];
        var m;
        while ((m = re.exec(smi)) !== null) {
            var time = parseInt(m[1], 10);
            var text = m[2]
                .replace(/<br\s*\/?>/gi, '\n')
                .replace(/<[^>]+>/g, '')
                .replace(/&nbsp;/gi, '')
                .replace(/&amp;/gi,  '&')
                .replace(/&lt;/gi,   '<')
                .replace(/&gt;/gi,   '>')
                .replace(/&quot;/gi, '"')
                .trim();
            cues.push({ time: time, text: text });
        }
        for (var i = 0; i < cues.length; i++) {
            if (!cues[i].text) continue;
            var nextTime = cues[i + 1] ? cues[i + 1].time : (cues[i].time + 5000);
            out.push(msToVttTime(cues[i].time) + ' --> ' + msToVttTime(nextTime));
            out.push(cues[i].text);
            out.push('');
        }
        return out.join('\n');
    }
    function msToVttTime(ms) {
        var h   = Math.floor(ms / 3600000); ms -= h * 3600000;
        var min = Math.floor(ms / 60000);   ms -= min * 60000;
        var s   = Math.floor(ms / 1000);    ms -= s * 1000;
        var p2 = function (n) { return n < 10 ? '0' + n : '' + n; };
        var p3 = function (n) { return n < 10 ? '00' + n : n < 100 ? '0' + n : '' + n; };
        return p2(h) + ':' + p2(min) + ':' + p2(s) + '.' + p3(ms);
    }

    return {
        setListener:        setListener,
        open:               open,
        play:               play,
        pause:              pause,
        togglePause:        togglePause,
        stop:               stop,
        seekRel:            seekRel,
        seekTo:             seekTo,
        currentTime:        currentTime,
        duration:           duration,
        state:              state,
        getTracks:          getTracks,
        setAudioTrack:      setAudioTrack,
        setSubtitleTrack:   setSubtitleTrack,
        setDisplayRect:     setDisplayRect
    };
})();

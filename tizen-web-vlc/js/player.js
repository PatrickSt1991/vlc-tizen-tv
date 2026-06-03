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
        onstatechange:  null,
        onerror:        null,
        onbuffering:    null,
        onprogress:     null,
        oncomplete:     null,
        onsubsupdated:  null    // fired when extracted-from-MP4 subs land in
                                // playerSubtitles after open() — lets the CC
                                // menu re-render if it's currently visible
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

    /* Tell AVPlay to load an external subtitle file by path.  Samsung's
     * own sample (SampleWebApps-PlayerAvplayWithSubtitles) uses this API:
     * strip 'file://' from the URI, hand AVPlay the raw path,
     * setSilentSubtitle(false) to make it deliver cues via the
     * onsubtitlechange callback.
     *
     * BUG: on Tizen 5.0 this call triggers a silent seek to ~midway in the
     * file when invoked AFTER play() has started.  So we only use it BEFORE
     * play() (avOpen's prepare callback, READY state — no seek).  Every
     * mid-playback switch goes through applyExternalSubtitleLive() instead,
     * which renders with the JS time-poller and never moves the playhead. */
    var currentExternalSub = null;
    /* Pre-play ONLY: apply an external subtitle through AVPlay's native
     * setExternalSubtitlePath while AVPlay is still in the READY state (i.e.
     * from inside the prepareAsync callback, before play()).  In that state
     * the call is safe.  Invoked mid-playback it triggers a silent seek to
     * mid-file on Tizen 5.0 — for that case use applyExternalSubtitleLive()
     * instead, which never moves the playhead.  Returns true on success. */
    function setAvExternalSubtitle(sub) {
        if (!sub) return false;
        if (currentExternalSub === sub) return true;      // already loaded
        var path = sub.fullPath || sub.uri || '';
        if (path.indexOf('file://') === 0) {
            path = path.slice(7);
            try { path = decodeURIComponent(path); } catch (e) {}
        }
        if (!path) return false;

        if (typeof Debug !== 'undefined') Debug.player('setExternalSubtitlePath (pre-play) ' + path);
        try {
            av().setExternalSubtitlePath(path);
        } catch (e) {
            if (typeof Debug !== 'undefined') Debug.error('setExternalSubtitlePath: ' + (e.message || e));
            return false;
        }
        try { av().setSilentSubtitle(false); } catch (e) {}
        currentExternalSub = sub;
        return true;
    }

    /* Mid-playback external-subtitle switch that does NOT touch playback
     * state — this is the fix for the sub-switch flicker (issue #4).
     *
     * AVPlay's setExternalSubtitlePath() seeks to mid-file when called during
     * PLAYING/PAUSED on Tizen 5.0; the old workaround detected that jump and
     * seeked back, and that seek-and-restore WAS the visible flicker.  Here we
     * skip the native call entirely and render cues with the JS time-poller
     * (reads getCurrentTime and paints the overlay), so the playhead never
     * moves.  AVPlay's own (broken) renderer is silenced so only our overlay
     * shows.  Visually identical to the native path — same #subtitle-overlay —
     * minus the jump. */
    function applyExternalSubtitleLive(sub) {
        if (!sub) return false;
        try { av().setSilentSubtitle(true); } catch (e) {}
        startExternalSubtitle(sub);
        currentExternalSub = sub;
        return true;
    }

    /* Pick the best external subtitle for a given language preference, used
     * to pre-apply at file open before play() — the only point at which
     * setExternalSubtitlePath doesn't cause the seek bug. */
    function pickBestExternalSubtitle(prefLang) {
        if (!prefLang || prefLang === 'off' || !playerSubtitles.length) return null;
        var want = prefLang.toLowerCase();
        var best = null;
        var bestScore = 0;
        for (var i = 0; i < playerSubtitles.length; i++) {
            var s = playerSubtitles[i];
            var lang = (s.lang || '').toLowerCase();
            var nm   = (s.name || '').toLowerCase();
            var sc = 0;
            if      (lang === want)                                            sc = 100;
            else if (lang && want.length === 2 && lang.indexOf(want) === 0)    sc = 90;
            else if (lang && lang.length === 2 && want.indexOf(lang) === 0)    sc = 90;
            else if (nm.indexOf(want) >= 0)                                    sc = 50;
            if (sc > bestScore) { bestScore = sc; best = s; }
        }
        return best;
    }

    /* AVPlay subtitle painter — three paths feed into the same overlay:
     *
     *   1. AVPlay's onsubtitlechange callback (used for embedded subs).  On
     *      some Tizen 5.0 firmwares this fires only for the first cue at
     *      track-select time, so we don't rely on it for external SRTs.
     *
     *   2. Time-based polling against parsed external SRT/VTT/ASS cues.
     *      When an external subtitle is selected, we parse the file once,
     *      store cues, and a 250 ms interval checks Player.currentTime()
     *      and paints the matching cue.  Bullet-proof against AVPlay's
     *      callback quirks.
     *
     *   3. HTML5 <track> rendering when the HTML5 backend is active —
     *      handled in h5Open.
     */
    var subClearTimer = null;
    var extCues = null;            // parsed external cues [{start, end, text}]
    var extPollTimer = null;
    var extLastCueIdx = -1;
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

        /* AVPlay's `duration` parameter is inconsistent between firmwares
         * and delivery paths:
         *   - embedded TEXT track via setSelectTrack: microseconds
         *     (3500 ms cue → 3500000)
         *   - external SRT via setExternalSubtitlePath:  milliseconds
         *     (3500 ms cue → 3500)
         * Heuristic: a value below 100,000 is millisecond-units (a 100-second
         * cue is already extreme), a value ≥ 100,000 must be microseconds.
         * 0 means 'show until next cue' — AVPlay reliably sends a follow-up
         * blank cue (text=" ", dur=0) to clear between cues, but we still
         * add a safety timer in case the last cue at end-of-stream never
         * gets one. */
        var d = 0;
        if (typeof durationMs === 'number' && durationMs > 0) {
            d = durationMs >= 100000 ? Math.round(durationMs / 1000) : durationMs;
        }
        if (d <= 0 || d > 30000) d = 8000;   // safety net + upper bound
        subClearTimer = setTimeout(hideSubtitleText, d);
    }
    function hideSubtitleText() {
        clearTimeout(subClearTimer);
        var el = subEl();
        if (el) { el.textContent = ''; el.classList.add('hidden'); }
    }

    /* ── External subtitle file (time-based, backend-agnostic) ──────────
     *
     * Parses an SRT/VTT/ASS file into [{start, end, text}] cues, then sets
     * up a 250 ms interval that checks Player.currentTime() and paints the
     * matching cue.  Works on AVPlay even when its own subtitle callback
     * is unreliable. */
    function startExternalSubtitle(sub) {
        stopExternalSubtitle();
        if (!sub || typeof Browser === 'undefined' || !Browser.readSubtitleText) return;
        Browser.readSubtitleText(sub, function (err, text) {
            if (err) {
                if (typeof Debug !== 'undefined') Debug.error('external sub load: ' + (err.message || err));
                return;
            }
            switch (sub.ext) {
                case 'vtt':                 extCues = parseVttCues(text); break;
                case 'srt':                 extCues = parseSrtCues(text); break;
                case 'ass':
                case 'ssa':                 extCues = parseVttCues(assToVtt(text)); break;
                case 'smi':
                case 'sami':                extCues = parseVttCues(smiToVtt(text)); break;
                default:                    extCues = parseSrtCues(text); break;
            }
            if (typeof Debug !== 'undefined') Debug.player('external sub loaded: ' + extCues.length + ' cues');
            extLastCueIdx = -1;
            extPollTimer = setInterval(extPoll, 250);
        });
    }
    function stopExternalSubtitle() {
        clearInterval(extPollTimer);
        extPollTimer = null;
        extCues = null;
        extLastCueIdx = -1;
        hideSubtitleText();
    }
    function extPoll() {
        if (!extCues || !extCues.length) return;
        var t = 0;
        if (backend === BACKEND_AVPLAY) {
            try { t = av().getCurrentTime() / 1000; } catch (e) {}
        } else if (backend === BACKEND_HTML5) {
            t = h5el().currentTime || 0;
        }
        // Find the cue whose [start, end) contains t.  Cues are sorted; we
        // binary-ish search by scanning since N is small.
        var idx = -1;
        for (var i = 0; i < extCues.length; i++) {
            if (t >= extCues[i].start && t < extCues[i].end) { idx = i; break; }
            if (extCues[i].start > t) break;
        }
        if (idx === extLastCueIdx) return;
        extLastCueIdx = idx;
        if (idx < 0) hideSubtitleText();
        else         showSubtitleText(extCues[idx].text, 0);   // 0 → no timer
    }

    function parseSrtCues(srt) {
        var out = [];
        var blocks = String(srt || '').replace(/\r/g, '').split(/\n\n+/);
        for (var i = 0; i < blocks.length; i++) {
            var lines = blocks[i].split('\n');
            // Skip optional numeric index
            var idx = 0;
            if (/^\d+$/.test(lines[idx])) idx++;
            var m = /(\d\d):(\d\d):(\d\d)[,.](\d{3})\s*-->\s*(\d\d):(\d\d):(\d\d)[,.](\d{3})/.exec(lines[idx] || '');
            if (!m) continue;
            var start = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
            var end   = (+m[5]) * 3600 + (+m[6]) * 60 + (+m[7]) + (+m[8]) / 1000;
            var text  = lines.slice(idx + 1).join('\n').trim();
            if (text) out.push({ start: start, end: end, text: text });
        }
        return out;
    }
    function parseVttCues(vtt) {
        // Strip the WEBVTT header then treat the body like SRT (timecodes use
        // dot-decimal; the regex in parseSrtCues accepts both . and ,).
        var body = String(vtt || '').replace(/^WEBVTT[^\n]*\n/, '');
        return parseSrtCues(body);
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
            /* This is the Samsung-recommended pattern (see their sample
             * SampleWebApps-PlayerAvplayWithSubtitles).  When AVPlay loads
             * subtitles via setExternalSubtitlePath() OR via embedded TEXT
             * tracks, it fires this callback with each cue's text.  We just
             * paint it.  AVPlay does NOT render subtitles natively on its
             * video plane on this firmware — the app has to. */
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

                    /* Pre-apply preferred external subtitle BEFORE play() —
                     * calling setExternalSubtitlePath after play() triggers a
                     * silent seek to mid-file on Tizen 5.0.  Doing it here,
                     * with AVPlay in the READY state, avoids the bug. */
                    if (typeof Settings !== 'undefined') {
                        var pref = Settings.get('subtitleLang');
                        var sub  = pickBestExternalSubtitle(pref);
                        if (sub) setAvExternalSubtitle(sub);
                    }

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
    var playerSubtitles = [];   // sibling subtitle files, regardless of backend
    /* Legacy alias — older code paths used h5Subtitles directly */
    var h5Subtitles = playerSubtitles;
    function h5Open(url, opts) {
        var v = h5el();
        v.style.display = 'block';
        // playerSubtitles is set in open() for both backends; keep alias
        h5Subtitles = playerSubtitles;

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

    /* Extract embedded text-subtitle tracks from a local MP4 / MKV / WebM,
     * write each one to wgt-private-tmp as SRT, and append them to
     * playerSubtitles so they appear in the CC menu alongside any sibling
     * SRTs.
     *
     * Workaround for the firmware bug where AVPlay's setSelectTrack('TEXT')
     * only delivers the first cue.  setExternalSubtitlePath delivers cues
     * correctly per-frame, so we route embedded subs through that path.
     *
     * Fire-and-forget — extraction runs in parallel with avOpen().  If the
     * user has a preferred subtitle language and the matching track gets
     * extracted, we apply it after the fact via applyExternalSubtitleLive(),
     * which renders without seeking the playhead. */
    var lastExtractToken = 0;
    function extractAndAppendEmbeddedSubs(url) {
        var lower = String(url || '').toLowerCase().split('?')[0];
        var extractor, label;
        if (/\.mp4$|\.m4v$|\.mov$/.test(lower) && typeof Mp4Subs !== 'undefined') {
            extractor = Mp4Subs; label = 'MP4';
        } else if (/\.mkv$|\.webm$/.test(lower) && typeof MkvSubs !== 'undefined') {
            extractor = MkvSubs; label = 'MKV';
        } else {
            return;
        }

        var token = ++lastExtractToken;
        if (typeof Debug !== 'undefined') Debug.player(label + ' sub extract: starting on ' + url);
        extractor.extract(url, function (err, subs) {
            if (token !== lastExtractToken) return;
            if (err) {
                if (typeof Debug !== 'undefined') Debug.warn(label + ' sub extract failed: ' + (err.message || err));
                return;
            }
            if (!subs || !subs.length) {
                if (typeof Debug !== 'undefined') Debug.player(label + ' sub extract: no text tracks found');
                return;
            }
            if (typeof Debug !== 'undefined')
                Debug.player(label + ' sub extract: ' + subs.length + ' track(s) — writing to wgt-private-tmp');

            var remaining = subs.length;
            subs.forEach(function (s, i) {
                extractor.writeSrtToTmp(s.srt, 'track' + i + '_' + (s.lang || 'unk'), function (werr, rec) {
                    remaining--;
                    if (token !== lastExtractToken) return;
                    if (werr || !rec) {
                        if (typeof Debug !== 'undefined') Debug.warn('writeSrtToTmp: ' + ((werr && (werr.message || werr)) || 'no record'));
                    } else {
                        playerSubtitles.push({
                            name:       'Embedded subtitle ' + (i + 1) + ' (' + label + ')',
                            lang:       s.lang || '',
                            ext:        'srt',
                            file:       rec.file,
                            uri:        rec.uri,
                            fullPath:   rec.fullPath,
                            _extracted: true,
                            _cueCount:  s.cues.length
                        });
                        if (typeof Debug !== 'undefined')
                            Debug.player('extracted sub written: lang=' + (s.lang || '?') +
                                         ' cues=' + s.cues.length + ' fullPath=' + rec.fullPath);
                    }
                    if (remaining === 0) onMp4SubExtractionDone();
                });
            });
        });
    }
    // Old name kept as alias for any cached references.
    var extractAndAppendMp4Subs = extractAndAppendEmbeddedSubs;

    function onMp4SubExtractionDone() {
        h5Subtitles = playerSubtitles;
        emit('onsubsupdated');

        // Auto-apply preferred language to one of the just-extracted tracks
        // if nothing is currently showing.
        if (currentExternalSub) return;
        if (backend !== BACKEND_AVPLAY) return;
        if (typeof Settings === 'undefined') return;
        var pref = Settings.get('subtitleLang');
        if (!pref || pref === 'off') return;
        var pick = pickBestExternalSubtitle(pref);
        if (pick) {
            if (typeof Debug !== 'undefined')
                Debug.player('auto-apply extracted sub after open: ' + pick.name);
            // Extraction finishes after play() has started, so this is a
            // mid-playback apply — use the no-seek poller path.
            applyExternalSubtitleLive(pick);
        }
    }

    function open(url, opts) {
        opts = opts || {};
        playerSubtitles = (opts.subtitles) ? opts.subtitles.slice() : [];
        h5Subtitles = playerSubtitles;
        stopExternalSubtitle();    // clear any previous file's poller
        backend = pickBackend(url);
        var streamType = sniffStreamType(url);
        if (typeof Debug !== 'undefined') Debug.player('open url=' + url + ' (type=' + streamType + ', backend=' + backend + ', subs=' + playerSubtitles.length + ')');

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
                // In parallel with avOpen: scan the file for embedded text
                // subtitle tracks (MP4 / MKV / WebM) and route them through
                // the working external-subtitle pipeline.  No-op for
                // unsupported containers.
                extractAndAppendEmbeddedSubs(url);

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
        else if (backend === BACKEND_AVPLAY) {
            try { av().play(); } catch (e) {}
            emit('onstatechange', 'playing');
        }
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
        stopExternalSubtitle();
        hideSubtitleText();
        currentExternalSub = null;
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
            // Off by default — see player.js header note.  User can flip this
            // in Settings if they have a file with usable embedded subs and
            // no external SRT sibling.
            var showEmbed = (typeof Settings !== 'undefined') &&
                            Settings.get('showEmbeddedSubs');
            // If we successfully extracted embedded subs into wgt-private-tmp,
            // suppress the broken native AVPLAY_EMBED entries — keeping both
            // would just confuse the user (one works, one doesn't).
            var hasExtracted = false;
            for (var ei = 0; ei < playerSubtitles.length; ei++) {
                if (playerSubtitles[ei]._extracted) { hasExtracted = true; break; }
            }
            if (hasExtracted) showEmbed = false;
            try {
                var info = av().getTotalTrackInfo();
                for (var i = 0; i < info.length; i++) {
                    var t = info[i];
                    var parsed = parseAvExtraInfo(t.extra_info);
                    if (t.type === 'VIDEO') continue;
                    if (t.type === 'AUDIO') {
                        out.audio.push({
                            index: t.index,
                            name:  parsed.label || ('Audio ' + t.index),
                            lang:  parsed.lang || '',
                            type:  'AVPLAY'
                        });
                    } else if ((t.type === 'TEXT' || t.type === 'SUBTITLE') && showEmbed) {
                        out.subtitle.push({
                            index: 'embed:' + t.index,
                            name:  '(embedded) ' + (parsed.label || ('Subtitle ' + t.index)),
                            lang:  parsed.lang || '',
                            type:  'AVPLAY_EMBED'
                        });
                    }
                }
            } catch (e) {}
            // External sibling subtitle files — always listed; this is the
            // reliable rendering path on this firmware.  Extracted-from-MP4
            // subs live in the same array but get a slightly different label
            // so the user can tell where they came from.
            for (var k = 0; k < playerSubtitles.length; k++) {
                var s = playerSubtitles[k];
                var label = (s.lang ? '[' + s.lang.toUpperCase() + '] ' : '') + s.name;
                out.subtitle.push({
                    index: 'ext:' + k,
                    name:  label,
                    lang:  s.lang || '',
                    type:  s._extracted ? 'AVPLAY_EXTRACTED' : 'AVPLAY_EXTERNAL'
                });
            }
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
            /* Tizen 5.0 quirk: setSelectTrack('AUDIO', N) registers the new
             * track index, but the audio decoder keeps using whatever frames
             * it had already buffered with the previous track — so the user
             * hears no change until the buffer drains (often never, if the
             * buffer is large).  Force a buffer flush by seeking to a point
             * slightly behind the current playhead.  Tiny rewind (~750 ms)
             * is barely audible and makes AVPlay rebuild the audio pipeline
             * with the new track immediately. */
            var savedMs = 0;
            var savedState = 'NONE';
            try {
                savedState = av().getState();
                savedMs    = av().getCurrentTime();
            } catch (e) {}
            if (typeof Debug !== 'undefined')
                Debug.player('setSelectTrack AUDIO ' + index + ' (state=' + savedState + ' t=' + savedMs + 'ms)');
            try {
                av().setSelectTrack('AUDIO', index);
            } catch (e) {
                if (typeof Debug !== 'undefined') Debug.error('setSelectTrack AUDIO: ' + (e.message || e));
                return;
            }
            // Flush by seeking to ~750 ms behind the playhead.  Skip when
            // we're near the start (under 1 s in) — nothing to flush yet.
            if (savedMs > 1000 && (savedState === 'PLAYING' || savedState === 'PAUSED')) {
                var flushTo = Math.max(0, savedMs - 750);
                try { av().seekTo(flushTo); } catch (e) {}
                if (typeof Debug !== 'undefined') Debug.player('  audio-track flush seek → ' + flushTo + 'ms');
            }
            return;
        }
        if (backend === BACKEND_HTML5) {
            var v = h5el();
            if (v.audioTracks) {
                for (var i = 0; i < v.audioTracks.length; i++)
                    v.audioTracks[i].enabled = (i === index);
            }
        }
    }

    function setSubtitleTrack(index) {
        if (backend === BACKEND_AVPLAY) {
            hideSubtitleText();
            stopExternalSubtitle();

            // "Off"
            if (index === -1 || index === undefined || index === 'off') {
                try { av().setSilentSubtitle(true); } catch (e) {}
                currentExternalSub = null;   // allow re-selecting the same sub later
                return;
            }

            // External subtitle file: render via the JS time-poller so the
            // switch doesn't seek (see applyExternalSubtitleLive).  This is a
            // mid-playback switch by definition — the CC menu is only reachable
            // once the OSD is up, i.e. after playback has started.
            if (typeof index === 'string' && index.indexOf('ext:') === 0) {
                var k = parseInt(index.slice(4), 10);
                var sub = playerSubtitles[k];
                if (!sub) return;
                applyExternalSubtitleLive(sub);
                if (typeof Debug !== 'undefined')
                    Debug.player('external sub via JS poller (no-seek): ' + sub.name);
                return;
            }

            // Embedded subtitle: "embed:<i>" — delegate to AVPlay's own track API
            var embedIdx = (typeof index === 'string' && index.indexOf('embed:') === 0)
                ? parseInt(index.slice(6), 10)
                : index;
            try { av().setSilentSubtitle(false); } catch (e) {}
            try { av().setSelectTrack('TEXT', embedIdx); }
            catch (e) { try { av().setSelectTrack('SUBTITLE', embedIdx); } catch (e2) {} }
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

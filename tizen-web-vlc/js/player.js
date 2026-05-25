/* Player wrapper — auto-selects backend based on URL scheme.
 *
 *   file:// or /opt/... (local files) → HTML5 <video>
 *      AVPlay's local-file pipeline is broken on Samsung TV 5.0 (it opens,
 *      reports PLAYING, but never decodes).  The WebView's chromium media
 *      stack handles file:// fine and shares the same hardware decoders.
 *
 *   http / https / rtsp / rtmp / .m3u8 / .mpd → Samsung AVPlay
 *      Hardware-accelerated, supports HLS, DASH, RTSP, etc.  Proven on
 *      this firmware.
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
    function pickBackend(url) {
        return isLocalUrl(url) ? BACKEND_HTML5 : BACKEND_AVPLAY;
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

    var avPollTimer = null;
    var avLastDebugT = 0, avLastDebugPos = 0;
    function avStartPolling() {
        avStopPolling();
        avLastDebugT = 0; avLastDebugPos = 0;
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
            } catch (e) {}
        }, 500);
    }
    function avStopPolling() {
        if (avPollTimer) { clearInterval(avPollTimer); avPollTimer = null; }
    }

    function avOpen(url) {
        if (!av()) { emit('onerror', 'AVPlay API not available'); return; }
        try { av().close(); } catch (e) {}
        try {
            av().open(url);
            if (typeof Debug !== 'undefined') Debug.player('AV open() returned');
        } catch (e) {
            emit('onerror', 'AVPlay open(): ' + (e.message || e));
            return;
        }
        try {
            av().setListener({
                onbufferingstart:    function () { emit('onbuffering', true); },
                onbufferingcomplete: function () { emit('onbuffering', false); },
                onstreamcompleted:   function () { emit('oncomplete'); },
                onerror:             function (e) { emit('onerror', e); },
                onerrormsg:          function (c, m) { emit('onerror', m || c); }
            });
        } catch (e) {}

        try {
            av().prepareAsync(
                function () {
                    avSetDisplayRect();
                    avSetDisplayMethod();
                    try { av().play(); } catch (e) {}
                    avStartPolling();
                    emit('onstatechange', 'playing');
                },
                function (err) { emit('onerror', 'prepare failed: ' + (err && err.message ? err.message : err)); }
            );
        } catch (e) {
            try { av().prepare(); av().play(); avStartPolling(); emit('onstatechange', 'playing'); }
            catch (e2) { emit('onerror', 'prepare failed: ' + (e2.message || e2)); }
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
            avOpen(url);
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
                    if (t.type === 'AUDIO')
                        out.audio.push({ index: t.index, name: t.extra_info || ('Audio ' + t.index), type: 'AVPLAY' });
                    else
                        out.subtitle.push({ index: t.index, name: t.extra_info || ('Subtitle ' + t.index), type: 'AVPLAY' });
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

    /* Convert a subtitle file (.vtt or .srt) to a VTT Blob URL the <track>
     * element can load.  Tizen's filesystem reads the file as text, we convert
     * SRT timing/numbering to VTT format and prepend the "WEBVTT" header. */
    function loadSubtitleAsVTT(sub, cb) {
        if (typeof Browser === 'undefined' || !Browser.readSubtitleText) {
            cb(new Error('Browser.readSubtitleText not available'));
            return;
        }
        Browser.readSubtitleText(sub, function (err, text) {
            if (err) { cb(err); return; }
            var vtt;
            if (sub.ext === 'vtt') {
                vtt = text;
            } else if (sub.ext === 'srt') {
                vtt = srtToVtt(text);
            } else {
                cb(new Error('unsupported subtitle ext: ' + sub.ext));
                return;
            }
            try {
                var blob = new Blob([vtt], { type: 'text/vtt' });
                var url  = URL.createObjectURL(blob);
                cb(null, url);
            } catch (e) { cb(e); }
        });
    }

    function srtToVtt(srt) {
        // SRT: "00:00:01,234 --> 00:00:05,678"   VTT: "00:00:01.234 --> 00:00:05.678"
        // SRT also numbers cues; VTT doesn't require numbering (the browser ignores it
        // if there) but stripping is cleaner.
        var lines = srt.replace(/\r/g, '').split('\n');
        var out = ['WEBVTT', ''];
        for (var i = 0; i < lines.length; i++) {
            var l = lines[i];
            // Skip pure-numeric cue index lines
            if (/^\d+\s*$/.test(l)) continue;
            // Convert timing
            l = l.replace(/(\d\d:\d\d:\d\d),(\d{3})/g, '$1.$2');
            out.push(l);
        }
        return out.join('\n');
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

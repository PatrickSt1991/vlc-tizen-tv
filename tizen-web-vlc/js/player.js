/* AVPlay wrapper.
 *
 * Samsung's webapis.avplay.* is the API every TV media app uses.  It supports
 * H.264, HEVC, VP9, AAC, MP3, AC3, HLS, MPEG-DASH, RTSP, smooth-streaming,
 * subtitles (CEA/SMI/SRT) and DRM.  Way more than HTML5 <video> alone.
 *
 * The render target is the #player-object element — must exist in the DOM
 * before `open()` is called.  Display rect must be set to the area we want
 * the video to fill (usually the whole screen). */

var Player = (function () {
    var avplay = null;
    var listeners = {
        onstatechange: null,
        onerror:       null,
        onbuffering:   null,
        onprogress:    null,
        oncomplete:    null
    };
    var pollTimer = null;

    function api() {
        if (avplay) return avplay;
        if (typeof webapis !== 'undefined' && webapis.avplay) avplay = webapis.avplay;
        return avplay;
    }

    function setDisplayRect() {
        try {
            // On TV the chrome's window.innerWidth is sometimes 0 before first
            // layout — fall back to the screen dimensions (always 1920x1080 on
            // a 1080p TV, 3840x2160 on 4K).  Then go again with 1920x1080 as
            // last resort because some firmwares don't expose screen.* either.
            var w = window.innerWidth  || screen.width  || 1920;
            var h = window.innerHeight || screen.height || 1080;
            api().setDisplayRect(0, 0, w, h);
            if (typeof Debug !== 'undefined') Debug.player('setDisplayRect ' + w + 'x' + h);
        } catch (e) {
            if (typeof Debug !== 'undefined') Debug.warn('setDisplayRect: ' + e.message);
        }
    }

    function setDisplayMethod() {
        try {
            // Letterbox preserves aspect ratio; full-screen would stretch.
            api().setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX');
            if (typeof Debug !== 'undefined') Debug.player('setDisplayMethod LETTER_BOX');
        } catch (e) {
            if (typeof Debug !== 'undefined') Debug.warn('setDisplayMethod: ' + e.message);
        }
    }

    function setListener(name, fn) {
        if (name in listeners) listeners[name] = fn;
    }

    function emit(name) {
        if (listeners[name]) listeners[name].apply(null, [].slice.call(arguments, 1));
    }

    /* AVPlay state polling — `getState()` is reliable, `setListener()` events
     * are sometimes flaky on older firmware so we poll position/duration too. */
    function startPolling() {
        stopPolling();
        pollTimer = setInterval(function () {
            try {
                var state = api().getState();
                var time  = api().getCurrentTime();
                var dur   = api().getDuration();
                emit('onprogress', { state: state, time: time, duration: dur });
            } catch (e) {}
        }, 500);
    }
    function stopPolling() {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    /* Sniff stream type from URL — AVPlay does its own detection but explicit
     * hints via setStreamingProperty(ADAPTIVE_INFO / COOKIE / USER_AGENT) make
     * RTSP/HLS/DASH more reliable, especially on older firmware. */
    function sniffStreamType(url) {
        var lower = String(url).toLowerCase().split('?')[0];
        if (lower.indexOf('rtsp://') === 0)  return 'RTSP';
        if (lower.indexOf('rtmp://') === 0)  return 'RTMP';
        if (lower.indexOf('mms://')  === 0)  return 'MMS';
        if (/\.m3u8?$/.test(lower))          return 'HLS';
        if (/\.mpd$/.test(lower))            return 'DASH';
        if (/\.ism\/?(?:Manifest)?$/.test(lower)) return 'SMOOTH';
        return 'PROGRESSIVE';
    }

    function open(url, opts) {
        opts = opts || {};
        var streamType = sniffStreamType(url);
        if (typeof Debug !== 'undefined') Debug.player('open url=' + url + ' (type=' + streamType + ')');
        if (!api()) {
            if (typeof Debug !== 'undefined') Debug.error('AVPlay API not available');
            emit('onerror', 'AVPlay API not available');
            return;
        }

        // If something is currently playing, tear it down cleanly first.
        try { api().close(); } catch (e) {}

        try {
            api().open(url);
            if (typeof Debug !== 'undefined') Debug.player('AVPlay open() returned');
        } catch (e) {
            if (typeof Debug !== 'undefined') Debug.error('AVPlay open() throw: ' + (e.message || e));
            emit('onerror', 'open() failed: ' + (e.message || e));
            return;
        }

        /* AVPlay's streaming-property keys vary across firmware versions; on
         * Tizen 5.0 most of the ones we'd want either don't exist or have
         * different names.  Skip them — defaults work fine. */

        // Listener with both state and progress events.
        try {
            api().setListener({
                onbufferingstart: function () {
                    if (typeof Debug !== 'undefined') Debug.player('buffering start');
                    emit('onbuffering', true);
                },
                onbufferingprogress: function (p) {},
                onbufferingcomplete: function () {
                    if (typeof Debug !== 'undefined') Debug.player('buffering complete');
                    emit('onbuffering', false);
                },
                oncurrentplaytime: function (ms) {
                    emit('onprogress', { time: ms, duration: safeDuration() });
                },
                onstreamcompleted: function () {
                    if (typeof Debug !== 'undefined') Debug.player('stream completed');
                    emit('oncomplete');
                },
                onerror: function (err) {
                    if (typeof Debug !== 'undefined') Debug.error('AVPlay onerror: ' + JSON.stringify(err));
                    emit('onerror', err);
                },
                onerrormsg: function (err, msg) {
                    if (typeof Debug !== 'undefined') Debug.error('AVPlay onerrormsg: code=' + err + ' msg=' + msg);
                    emit('onerror', msg || err);
                },
                onevent: function (name, data) {
                    if (typeof Debug !== 'undefined') Debug.player('event ' + name + ': ' + JSON.stringify(data));
                },
                onsubtitlechange: function (durationMs, text, type, attr) {},
                ondrmevent: function () {}
            });
        } catch (e) { /* listener setup is non-fatal */ }

        setDisplayRect();

        // Optional Samsung-specific advanced features
        try {
            api().setBufferingParam('PLAYER_BUFFER_FOR_PLAY', 'PLAYER_BUFFER_SIZE_IN_SECOND', 5);
        } catch (e) {}

        // prepareAsync is the modern path; falls back to prepare() if not present.
        // CRITICAL: after prepare succeeds we must set the display rect + method
        // AGAIN — AVPlay re-creates its surface internally and forgets prior
        // calls.  Without this the player ends up rendering at 0×0 (no visible
        // frame, no progress) even though state reports PLAYING.
        function afterPrepareOK() {
            setDisplayRect();
            setDisplayMethod();
            try {
                api().play();
                if (typeof Debug !== 'undefined') Debug.player('play() called');
            } catch (e) {
                if (typeof Debug !== 'undefined') Debug.error('play() after prepare: ' + e.message);
            }
            startPolling();
            emit('onstatechange', 'playing');
        }

        try {
            api().prepareAsync(
                function () {
                    if (typeof Debug !== 'undefined') Debug.player('prepareAsync OK');
                    afterPrepareOK();
                },
                function (err) {
                    if (typeof Debug !== 'undefined') Debug.error('prepareAsync failed: ' + JSON.stringify(err));
                    emit('onerror', 'prepare failed: ' + (err && err.message ? err.message : err));
                }
            );
        } catch (e) {
            if (typeof Debug !== 'undefined') Debug.warn('prepareAsync threw, falling back to prepare(): ' + e.message);
            try {
                api().prepare();
                afterPrepareOK();
            } catch (e2) {
                if (typeof Debug !== 'undefined') Debug.error('prepare() also failed: ' + e2.message);
                emit('onerror', 'prepare failed: ' + (e2.message || e2));
            }
        }
    }

    function safeDuration() {
        try { return api().getDuration(); } catch (e) { return 0; }
    }
    function safeTime() {
        try { return api().getCurrentTime(); } catch (e) { return 0; }
    }
    function safeState() {
        try { return api().getState(); } catch (e) { return 'NONE'; }
    }

    function togglePause() {
        var st = safeState();
        if (st === 'PLAYING')      { api().pause();  emit('onstatechange', 'paused');  }
        else if (st === 'PAUSED')  { api().play();   emit('onstatechange', 'playing'); }
        else if (st === 'IDLE' || st === 'NONE') {} // nothing to toggle
    }

    function play()  { try { api().play();  emit('onstatechange', 'playing'); } catch (e) {} }
    function pause() { try { api().pause(); emit('onstatechange', 'paused');  } catch (e) {} }

    function stop() {
        stopPolling();
        try { api().stop();  } catch (e) {}
        try { api().close(); } catch (e) {}
        emit('onstatechange', 'stopped');
    }

    function seekRel(deltaMs) {
        try {
            var t  = safeTime();
            var dur = safeDuration();
            var to = Math.max(0, Math.min(dur ? dur - 1000 : t + deltaMs, t + deltaMs));
            api().seekTo(to);
        } catch (e) {}
    }

    function seekTo(ms) {
        try { api().seekTo(Math.max(0, ms)); } catch (e) {}
    }

    /* Track enumeration for audio + subtitle pickers. */
    function getTracks() {
        var out = { audio: [], subtitle: [] };
        try {
            var info = api().getTotalTrackInfo();
            for (var i = 0; i < info.length; i++) {
                var t = info[i];
                var record = {
                    index: t.index,
                    type:  t.type,
                    extra: t.extra_info
                };
                if (t.type === 'AUDIO')        out.audio.push(record);
                else if (t.type === 'TEXT')    out.subtitle.push(record);
                else if (t.type === 'SUBTITLE') out.subtitle.push(record);
            }
        } catch (e) {}
        return out;
    }

    function setAudioTrack(index)   {
        try { api().setSelectTrack('AUDIO', index); } catch (e) {}
    }
    function setSubtitleTrack(index) {
        try { api().setSelectTrack('TEXT', index); } catch (e) {
            try { api().setSelectTrack('SUBTITLE', index); } catch (e2) {}
        }
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
        currentTime:        safeTime,
        duration:           safeDuration,
        state:              safeState,
        getTracks:          getTracks,
        setAudioTrack:      setAudioTrack,
        setSubtitleTrack:   setSubtitleTrack,
        setDisplayRect:     setDisplayRect
    };
})();

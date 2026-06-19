/* server.js — pairing with, and routing playback through, the optional
 * vlc-transcode-server companion (runs on the user's AM6b+ box).
 *
 * The idea: SMB browsing on the TV stays exactly as it is. The ONLY thing that
 * changes is where the bytes come from when you press play. If a transcode
 * server is paired, smb.js builds the playable URL from here
 * (http://<server>/play?path=…) instead of the localhost smbproxy stream — so
 * files the TV can't decode (DTS/TrueHD, heavy codecs) get transcoded on the box
 * and arrive as TV-friendly HLS. If nothing is paired, smb.js falls back to the
 * direct localhost stream and behaviour is unchanged.
 *
 * Pairing reuses the existing ntfy pairing code (UrlDrop.code()) but on a
 * separate "-srv" topic so it never collides with "Get URL from device". The
 * server posts its LAN URL + token there; we pull it once and store it.
 *
 * ES5 + XHR on purpose — safest on the Tizen 5.0 WebView.
 */
var TranscodeServer = (function () {
    'use strict';

    var STORE_KEY = 'vlctv_server_v1';
    var NTFY_BASE = 'https://ntfy.sh';

    function log(m) { if (typeof Debug !== 'undefined' && Debug.net) Debug.net('[server] ' + m); }

    /* ── stored pairing ({url, token, name}) ───────────────────────────── */
    function get() {
        try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); }
        catch (e) { return null; }
    }
    function set(s) {
        try { localStorage.setItem(STORE_KEY, JSON.stringify(s || null)); } catch (e) {}
    }
    function clear() { try { localStorage.removeItem(STORE_KEY); } catch (e) {} }
    function isPaired() { var s = get(); return !!(s && s.url); }

    /* Build the URL AVPlay should open for an SMB-relative path. The server
     * serves a live HLS manifest here (after transcoding/​remuxing as needed). */
    function playUrl(path) {
        var s = get();
        if (!s || !s.url) return null;
        var u = s.url.replace(/\/+$/, '') + '/play?path=' + encodeURIComponent(path);
        if (s.token) u += '&token=' + encodeURIComponent(s.token);
        return u;
    }

    /* Recognise our own play URLs so recent/watched tracking treats two routes
     * to the same file consistently. */
    function isPlayUrl(u) {
        var s = get();
        return !!(s && s.url && typeof u === 'string' && u.indexOf(s.url.replace(/\/+$/, '') + '/play') === 0);
    }

    /* ── pairing: pull the server's announcement off the -srv topic ─────── */
    function topic() {
        var code = (typeof UrlDrop !== 'undefined' && UrlDrop.code) ? UrlDrop.code() : '';
        return 'vlctv-' + code + '-srv';
    }

    function xhrGet(url, cb) {
        var done = false;
        function finish(err, text) { if (done) return; done = true; cb(err, text); }
        try {
            var x = new XMLHttpRequest();
            x.open('GET', url, true);
            x.timeout = 10000;
            x.onreadystatechange = function () {
                if (x.readyState !== 4) return;
                if (x.status >= 200 && x.status < 300) finish(null, x.responseText);
                else finish(new Error('HTTP ' + x.status));
            };
            x.ontimeout = function () { finish(new Error('timeout')); };
            x.onerror = function () { finish(new Error('network')); };
            x.send();
        } catch (e) { finish(e); }
    }

    /* ntfy poll returns newline-delimited JSON events; take the message body of
     * the last "message" event and JSON.parse it into the announcement. */
    function parseLatestAnnounce(text) {
        var lines = String(text || '').split('\n'), latest = null;
        for (var i = 0; i < lines.length; i++) {
            var ln = lines[i].trim();
            if (!ln) continue;
            var ev = null;
            try { ev = JSON.parse(ln); } catch (e) { continue; }
            if (ev && ev.event === 'message' && ev.message) latest = ev.message;
        }
        if (!latest) return null;
        try {
            var ann = JSON.parse(latest);
            if (ann && ann.type === 'vlc-transcode-server' && ann.url) return ann;
        } catch (e) {}
        return null;
    }

    /* Pull the announcement and store it. cb(err, announce). */
    function pair(cb) {
        var url = NTFY_BASE + '/' + encodeURIComponent(topic()) + '/json?poll=1';
        log('pair GET ' + url);
        xhrGet(url, function (err, text) {
            if (err) return cb(err);
            var ann = parseLatestAnnounce(text);
            if (!ann) return cb(new Error('no server found — open the tool and press Pair there first'));
            set({ url: ann.url, token: ann.token || '', name: ann.name || 'Transcode server' });
            log('paired with ' + ann.name + ' @ ' + ann.url);
            cb(null, ann);
        });
    }

    /* ── Settings UI wiring ─────────────────────────────────────────────── */
    function paintStatus() {
        var el = document.getElementById('srv-status-val');
        if (!el) return;
        var s = get();
        el.textContent = s && s.url ? (s.name || 'Paired') + ' · ' + s.url : 'Not paired';
    }

    function wireSettings() {
        var pairBtn = document.getElementById('srv-pair');
        var unpairBtn = document.getElementById('srv-unpair');
        paintStatus();
        if (pairBtn) pairBtn.addEventListener('click', function () {
            if (typeof UI !== 'undefined' && UI.toast) UI.toast('Looking for your transcode server…');
            pair(function (err) {
                if (err) { if (UI && UI.toast) UI.toast('Pairing failed: ' + err.message); return; }
                paintStatus();
                if (UI && UI.toast) UI.toast('Transcode server paired');
            });
        });
        if (unpairBtn) unpairBtn.addEventListener('click', function () {
            clear(); paintStatus();
            if (typeof UI !== 'undefined' && UI.toast) UI.toast('Transcode server removed');
        });
    }

    if (document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', wireSettings);
    else
        wireSettings();

    return {
        get: get, set: set, clear: clear, isPaired: isPaired,
        playUrl: playUrl, isPlayUrl: isPlayUrl, pair: pair
    };
})();

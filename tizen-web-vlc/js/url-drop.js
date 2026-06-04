/* url-drop.js — "paste a URL on your phone, pull it on the TV" with no relay
 * that you or your users have to host.
 *
 * How it dodges the no-inbound-socket wall:
 *   The TV is a *client*. A phone POSTs a URL to a free public pub/sub topic
 *   (ntfy.sh — no account, no signup); when the user presses "Get URL from
 *   phone" in the network view, the TV does a single GET of that topic and
 *   grabs the most recent message. Button-triggered pull, not background
 *   polling, so nothing drains the network when idle.
 *
 *   Pairing: each TV mints a long random code once (persisted via Settings).
 *   The topic is `vlctv-<code>`; the phone page takes the same code. Because
 *   the .wgt ships <access origin="*"> (WARP), the TV's cross-origin GET is
 *   exempt from CORS; ntfy also returns ACAO:* so the phone's POST works too.
 *
 *   Privacy: a public topic is readable by anyone who knows the code, so the
 *   code is long. Fine for public stream URLs; don't push secrets through it.
 *   To own the pipe instead, flip `adapter` to n8nAdapter (see below).
 *
 *   ES5 + XHR on purpose — safest on the Tizen 5.0 WebView.
 */
var UrlDrop = (function () {
    'use strict';

    var CODE_KEY   = 'urlDropCode';
    var NTFY_BASE  = 'https://ntfy.sh';
    // GitHub Pages page users open on their phone (deploy docs/index.html).
    var PHONE_PAGE = 'https://patrickst1991.github.io/vlc-tizen-tv/';

    function log(m) { if (typeof Debug !== 'undefined' && Debug.net) Debug.net('[url-drop] ' + m); }

    function genCode() {
        // ~10 base36 chars ≈ 3.6e15 space — not guessable, safe on a public topic.
        var s = '';
        while (s.length < 10) s += Math.random().toString(36).slice(2);
        return s.slice(0, 10);
    }

    function code() {
        var c = null;
        try { if (typeof Settings !== 'undefined') c = Settings.get(CODE_KEY); } catch (e) {}
        if (!c) {
            c = genCode();
            try { if (typeof Settings !== 'undefined') Settings.set(CODE_KEY, c); } catch (e) {}
        }
        return c;
    }

    function topic()     { return 'vlctv-' + code(); }
    function pageUrl()   { return PHONE_PAGE; }                 // bare page, easy to type
    function deviceUrl() { return PHONE_PAGE + '#' + code(); }  // page + code, for the QR
    function phoneUrl()  { return deviceUrl(); }                // back-compat alias

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
            x.onerror   = function () { finish(new Error('network')); };
            x.send();
        } catch (e) { finish(e); }
    }

    /* ntfy's poll endpoint returns newline-delimited JSON of cached events.
     * Take the message text of the last `event:"message"` line. */
    function parseNtfyLatest(text) {
        var lines = String(text || '').split('\n');
        var latest = null;
        for (var i = 0; i < lines.length; i++) {
            var ln = lines[i].trim();
            if (!ln) continue;
            var obj = null;
            try { obj = JSON.parse(ln); } catch (e) { continue; }
            if (obj && obj.event === 'message' && obj.message) latest = obj.message;
        }
        return latest ? String(latest).trim() : null;
    }

    /* ── Adapters ─────────────────────────────────────────────────────── */
    var ntfyAdapter = {
        fetchLatest: function (cb) {
            var url = NTFY_BASE + '/' + encodeURIComponent(topic()) + '/json?poll=1';
            log('GET ' + url);
            xhrGet(url, function (err, text) {
                if (err) return cb(err);
                cb(null, parseNtfyLatest(text));
            });
        }
    };

    /* Own-the-pipe alternative: point this at an n8n webhook that returns
     * {"url":"…"} for the latest drop, then set `adapter = n8nAdapter`.
     * Trade-off: every user now depends on your n8n instance. */
    var N8N_FETCH_URL = '';   // e.g. 'https://aareonnl.app.n8n.cloud/webhook/vlctv-latest'
    var n8nAdapter = {
        fetchLatest: function (cb) {
            if (!N8N_FETCH_URL) return cb(new Error('n8n url not set'));
            var url = N8N_FETCH_URL + (N8N_FETCH_URL.indexOf('?') < 0 ? '?' : '&') + 'code=' + encodeURIComponent(code());
            xhrGet(url, function (err, text) {
                if (err) return cb(err);
                var obj = null;
                try { obj = JSON.parse(text); } catch (e) {}
                cb(null, obj && obj.url ? String(obj.url).trim() : null);
            });
        }
    };

    var adapter = ntfyAdapter;

    function fetchLatest(cb) {
        try { adapter.fetchLatest(cb); }
        catch (e) { cb(e); }
    }

    return {
        code:       code,
        topic:      topic,
        pageUrl:    pageUrl,
        deviceUrl:  deviceUrl,
        phoneUrl:   phoneUrl,
        fetchLatest: fetchLatest
    };
})();

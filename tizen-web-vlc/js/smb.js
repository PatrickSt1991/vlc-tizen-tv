/* ============================================================================
 * SMB client glue (web side).
 * ----------------------------------------------------------------------------
 * Talks to the hybrid <tizen:service> ("smbproxy") over localhost HTTP. The
 * service does the actual SMB2; here we just launch it, hand it credentials,
 * browse folders, and turn a chosen file into an http://127.0.0.1 stream URL
 * that AVPlay can play — which means it flows through the app's normal
 * playFromList() path and inherits next/prev, auto-play, recent and watched
 * tracking for free.
 *
 * Credentials live in their own localStorage blob (Settings only persists its
 * fixed key set, so we don't try to smuggle SMB creds through it).
 * ==========================================================================*/

var SMB = (function () {

    var BASE = 'http://127.0.0.1:8127';
    var CREDS_KEY = 'vlctv_smb_v1';

    /* All SMB-side activity goes to the PC debug listener under one tag so the
     * connection flow is actually traceable (the old code called Debug.log,
     * which doesn't exist, so nothing was ever sent). */
    function dbg(msg) { if (typeof Debug !== 'undefined' && Debug.send) Debug.send('SMB', msg); }

    /* Pull the service's own ring-buffer log and forward the tail to the PC
     * listener — this is how we see the NEGOTIATE / auth / socket errors that
     * happen inside the background service, which can't reach the PC itself. */
    function dumpServiceLogs() {
        getJson(BASE + '/smb/debug/logs', function (err, res) {
            if (err || !res || !res.logs) { dbg('service logs unavailable: ' + (err ? err.message : 'none')); return; }
            var logs = res.logs, from = Math.max(0, logs.length - 40);
            for (var i = from; i < logs.length; i++) dbg('svc ' + logs[i]);
        });
    }

    /* ── credentials ───────────────────────────────────────────────────── */
    function getCreds() {
        try { return JSON.parse(localStorage.getItem(CREDS_KEY) || '{}'); }
        catch (e) { return {}; }
    }
    function setCreds(c) {
        try { localStorage.setItem(CREDS_KEY, JSON.stringify(c || {})); } catch (e) {}
    }
    function haveCreds() { var c = getCreds(); return !!(c.host && c.share); }

    /* ── tiny XHR helpers (the service sets permissive CORS) ───────────────*/
    function getJson(url, cb) {
        var x = new XMLHttpRequest();
        x.open('GET', url, true);
        x.timeout = 15000;
        x.onload = function () {
            try { cb(null, JSON.parse(x.responseText)); }
            catch (e) { cb(new Error('bad response')); }
        };
        x.onerror = function () { cb(new Error('service unreachable')); };
        x.ontimeout = function () { cb(new Error('timeout')); };
        x.send();
    }
    function postJson(url, body, cb) {
        var x = new XMLHttpRequest();
        x.open('POST', url, true);
        x.setRequestHeader('Content-Type', 'application/json');
        x.timeout = 20000;
        x.onload = function () {
            try { cb(null, JSON.parse(x.responseText)); }
            catch (e) { cb(new Error('bad response')); }
        };
        x.onerror = function () { cb(new Error('service unreachable')); };
        x.ontimeout = function () { cb(new Error('timeout')); };
        x.send(JSON.stringify(body || {}));
    }

    /* ── launch the hybrid service, then wait for it to answer /smb/ping ──── */
    function ensureService(cb) {
        try {
            var appId = tizen.application.getCurrentApplication().appInfo.id;
            var pkgId = appId.split('.')[0];
            dbg('launching service ' + pkgId + '.smbproxy');
            tizen.application.launch(pkgId + '.smbproxy',
                function () { dbg('service launch ok'); },
                function (e) { dbg('service launch error: ' + (e && e.message)); });
        } catch (e) {
            dbg('service launch threw: ' + e.message);
        }
        // The service may already be running from a previous open; poll either way.
        var tries = 0;
        (function poll() {
            getJson(BASE + '/smb/ping', function (err) {
                if (!err) { dbg('service ping ok after ' + tries + ' tries'); return cb(null); }
                if (++tries > 18) { dbg('service ping gave up after ' + tries + ' tries: ' + err.message); return cb(new Error('SMB service did not start')); }
                setTimeout(poll, 300);
            });
        })();
    }

    function connect(cb) {
        var c = getCreds();
        dbg('connect -> ' + (c.host || '?') + '\\' + (c.share || '?') +
            ' user=' + (c.anonymous ? '(guest)' : (c.user || '(none)')));
        postJson(BASE + '/smb/connect', {
            host: c.host, share: c.share, user: c.user || '',
            pass: c.pass || '', domain: c.domain || '', port: c.port || 445,
            anonymous: !!c.anonymous
        }, function (err, res) {
            if (err) { dbg('connect transport error: ' + err.message); return cb(err); }
            if (!res.ok) { dbg('connect rejected: ' + (res.error || 'unknown')); return cb(new Error(res.error || 'connect failed')); }
            dbg('connect ok: dialect=' + res.dialect + ' signing=' + res.signing);
            cb(null, res);
        });
    }

    function list(path, cb) {
        getJson(BASE + '/smb/list?path=' + encodeURIComponent(path || ''), function (err, res) {
            if (err) return cb(err);
            if (!res.ok) return cb(new Error(res.error || 'list failed'));
            cb(null, res.entries || []);
        });
    }

    /* The URL handed to AVPlay. The service streams the file with Range
     * support, so seeking works. */
    function streamUrl(path) {
        return BASE + '/smb/stream?path=' + encodeURIComponent(path);
    }

    /* ── browsing UI (reuses #view-browse, like the USB browser) ───────────*/
    var pathStack = [];     // breadcrumb of folder paths, '' === share root
    var backHandler = null;

    function humanSize(n) {
        if (!n) return '';
        var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0;
        while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
        return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
    }
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function isPlayable(name) {
        return /\.(mkv|mp4|m4v|mov|avi|webm|ts|m2ts|flv|wmv|mpe?g|mp3|flac|aac|m4a|ogg|wav|opus)$/i.test(name);
    }
    function join(dir, name) { return (dir ? dir.replace(/\/+$/, '') : '') + '/' + name; }

    function showError(msg) {
        var ul = document.getElementById('browse-list');
        if (ul) ul.innerHTML = '<li><span class="icon">!</span><span class="name">' + esc(msg) + '</span></li>';
    }

    function render(path) {
        UI.showView('view-browse');
        document.getElementById('browse-title').textContent = path ? path.split('/').pop() : 'SMB Share';
        document.getElementById('browse-path').textContent = '\\\\' + (getCreds().host || '') + '\\' + (getCreds().share || '') + (path || '');
        var ul = document.getElementById('browse-list');
        ul.innerHTML = '<li><span class="icon">…</span><span class="name">Loading…</span></li>';

        list(path, function (err, entries) {
            ul.innerHTML = '';
            if (err) { showError(err.message); return; }

            // Playable files in this folder → the playlist for next/prev/auto-play.
            var playlist = entries
                .filter(function (e) { return !e.isDir && isPlayable(e.name); })
                .map(function (e) { return { uri: streamUrl(join(path, e.name)), title: e.name }; });

            // ".." row to go up (except at root).
            if (pathStack.length > 0) {
                var up = document.createElement('li');
                up.dataset.dir = '1';
                up.innerHTML = '<span class="icon">↩</span><span class="name">..</span>';
                up.addEventListener('click', goUp);
                ul.appendChild(up);
            }

            entries.forEach(function (e) {
                if (!e.isDir && !isPlayable(e.name)) return;   // hide non-media
                var li = document.createElement('li');
                li.dataset.dir = e.isDir ? '1' : '0';
                li.innerHTML =
                    '<span class="icon">' + (e.isDir ? '📁' : '🎬') + '</span>' +
                    '<span class="name">' + esc(e.name) + '</span>' +
                    (e.isDir ? '' : '<span class="meta">' + humanSize(e.size) + '</span>');
                li.addEventListener('click', function () {
                    if (e.isDir) {
                        pathStack.push(path);
                        render(join(path, e.name));
                        return;
                    }
                    var uri = streamUrl(join(path, e.name));
                    var idx = 0;
                    for (var i = 0; i < playlist.length; i++) if (playlist[i].uri === uri) { idx = i; break; }
                    // Hand off to the player; release our Back handler so the
                    // player's own Back (exit) behaviour takes over.
                    teardownBack();
                    if (window.VlcApp && window.VlcApp.play) window.VlcApp.play('smb', playlist, idx);
                });
                ul.appendChild(li);
            });

            if (!ul.children.length)
                ul.innerHTML = '<li><span class="icon">i</span><span class="name">Empty folder.</span></li>';

            UI.refreshFocusables();
            UI.focusOn(ul.firstElementChild);
        });
    }

    function goUp() {
        if (!pathStack.length) { exit(); return; }
        var parent = pathStack.pop();
        render(parent);
    }
    function exit() {
        teardownBack();
        if (window.VlcApp && window.VlcApp.home) window.VlcApp.home();
        else UI.showView('view-home');
    }

    function setupBack() {
        if (backHandler) return;
        backHandler = Remote.push(function (code) {
            if (code === Remote.KEY.BACK) { goUp(); return true; }
            return false;   // arrows / Enter fall through to the app's focus system
        });
    }
    function teardownBack() {
        if (backHandler) { Remote.pop(backHandler); backHandler = null; }
    }

    /* Entry point from the home tile. */
    function openBrowser() {
        if (!haveCreds()) {
            UI.toast('Add your SMB server in Settings first');
            if (window.VlcApp && window.VlcApp.openSettings) window.VlcApp.openSettings();
            return;
        }
        UI.showView('view-browse');
        document.getElementById('browse-title').textContent = 'SMB Share';
        document.getElementById('browse-path').textContent = 'Connecting…';
        document.getElementById('browse-list').innerHTML =
            '<li><span class="icon">…</span><span class="name">Connecting…</span></li>';

        // Install Back BEFORE the async work so it works on the "connecting" and
        // error screens too — otherwise Back falls through to the app's global
        // handler, which still thinks we're on the home view and can't exit here.
        pathStack = [];
        setupBack();

        dbg('openBrowser');
        ensureService(function (err) {
            if (err) { dbg('ensureService failed: ' + err.message); showError(err.message); return; }
            connect(function (err2) {
                if (err2) {
                    showError('Could not connect: ' + err2.message + ' — press Back to return');
                    dumpServiceLogs();   // surface the service-side NEGOTIATE/auth/socket trail
                    return;
                }
                render('');
            });
        });
    }

    /* Wire the Settings form (inputs + Save button) once the DOM is ready. */
    function wireSettingsForm() {
        var btn = document.getElementById('smb-save');
        if (!btn) return;
        var c = getCreds();
        var ids = ['host', 'share', 'user', 'pass', 'domain'];
        ids.forEach(function (k) {
            var el = document.getElementById('smb-' + k);
            if (el && c[k] != null) el.value = c[k];
        });

        // Guest is a toggle button (not a checkbox): the D-pad's geometric nav
        // can't reliably land on a small right-aligned checkbox, but a
        // full-width row matches every other setting and gets focus cleanly.
        var anonBtn = document.getElementById('smb-anon');
        var anonVal = document.getElementById('smb-anon-val');
        var anonState = !!c.anonymous;
        function paintAnon() { if (anonVal) anonVal.textContent = anonState ? 'On' : 'Off'; }
        paintAnon();
        if (anonBtn) anonBtn.addEventListener('click', function () { anonState = !anonState; paintAnon(); });

        btn.addEventListener('click', function () {
            var nc = {};
            ids.forEach(function (k) {
                var el = document.getElementById('smb-' + k);
                nc[k] = el ? el.value.trim() : '';
            });
            nc.anonymous = anonState;
            setCreds(nc);
            UI.toast('SMB server saved');
        });
    }

    if (document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', wireSettingsForm);
    else
        wireSettingsForm();

    return {
        openBrowser: openBrowser,
        getCreds: getCreds,
        setCreds: setCreds,
        streamUrl: streamUrl
    };
})();

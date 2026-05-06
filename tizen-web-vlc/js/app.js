/* Top-level app coordinator: state, view transitions, action dispatch.
 *
 * Views (mutually exclusive):
 *   home    — start screen with three tiles
 *   url     — keyboard-input URL entry
 *   browse  — file browser (USB / local roots)
 *   player  — fullscreen video with OSD
 */

(function () {

    /* ── Recently-played (localStorage-backed, capped) ───────────────── */
    var RECENT_KEY = 'vlctv_recent_v1';
    function getRecent() {
        try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); }
        catch (e) { return []; }
    }
    function pushRecent(item) {
        var list = getRecent().filter(function (x) { return x.uri !== item.uri; });
        list.unshift(item);
        list = list.slice(0, 20);
        try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch (e) {}
    }

    /* ── State ────────────────────────────────────────────────────── */
    var state = {
        view:       'home',        // home | url | browse | player
        browseDir:  null,          // current Tizen File or null at root listing
        browseAtRoot: true,        // true when listing the virtual roots
        playingUri: null,
        playingTitle: ''
    };

    /* ── Init ─────────────────────────────────────────────────────── */
    function init() {
        Remote.init();

        // Wire button data-action click → dispatch.  Buttons stay
        // keyboard-activatable too because UI.activateFocused() calls click().
        document.body.addEventListener('click', function (ev) {
            var t = ev.target.closest('[data-action]');
            if (t) handleAction(t.dataset.action, t);
        });

        // Preset URL chips
        document.querySelectorAll('.preset').forEach(function (el) {
            el.addEventListener('click', function () {
                document.getElementById('url-input').value = el.dataset.url;
                openUrl(el.dataset.url);
            });
        });

        // Global remote handler — dispatched per current view
        Remote.push(globalKeyHandler);

        // Player events
        Player.setListener('onstatechange', function (s) {
            if (typeof Debug !== 'undefined') Debug.player('state → ' + s);
            updatePlayPauseButton(s);
            if (s === 'playing') {
                hideSpinner();
                showOSD(true);
                scheduleOSDHide();
            }
        });
        Player.setListener('onerror', function (msg) {
            var text = typeof msg === 'string' ? msg
                       : (msg && msg.message ? msg.message : JSON.stringify(msg));
            if (typeof Debug !== 'undefined') Debug.error('player onerror: ' + text);
            showError(text);
        });
        Player.setListener('onbuffering', function (active) {
            if (active) showSpinner('Buffering…');
            else hideSpinner();
        });
        Player.setListener('onprogress', function (p) {
            updateProgress(p && p.time, p && p.duration);
        });
        Player.setListener('oncomplete', function () {
            UI.toast('Playback finished');
            backToHome();
        });

        // Reflow display rect on size changes
        window.addEventListener('resize', Player.setDisplayRect);

        UI.showView('view-home');
    }

    /* ── Action dispatcher ────────────────────────────────────────── */
    function handleAction(action, el) {
        if (typeof Debug !== 'undefined') Debug.action(action);
        switch (action) {
            case 'open-url':           UI.showView('view-url'); state.view = 'url'; break;
            case 'browse-usb':         openBrowserAtRoot(); break;
            case 'browse-recent':      openRecent(); break;
            case 'open-current-url': {
                var v = document.getElementById('url-input').value.trim();
                if (v) openUrl(v);
                else UI.toast('Enter a URL first');
                break;
            }
            case 'back-home':          backToHome(); break;
            case 'play-pause':         Player.togglePause(); scheduleOSDHide(); break;
            case 'stop':               Player.stop(); backToHome(); break;
            case 'rewind':             Player.seekRel(-10000); flashOSD(); break;
            case 'forward':            Player.seekRel( 10000); flashOSD(); break;
            case 'seek-backward':      Player.seekRel(-60000); flashOSD(); break;
            case 'seek-forward':       Player.seekRel( 60000); flashOSD(); break;
            case 'open-track-menu':    openTrackMenu(); break;
            case 'close-track-menu':   closeTrackMenu(); break;
        }
    }

    /* ── URL playback ─────────────────────────────────────────────── */
    function openUrl(url) {
        playUri(url, urlBaseName(url));
    }
    function urlBaseName(url) {
        try {
            var p = url.split('?')[0].split('#')[0];
            var seg = p.split('/').filter(Boolean);
            return decodeURIComponent(seg[seg.length - 1] || url);
        } catch (e) { return url; }
    }

    /* ── File browser ─────────────────────────────────────────────── */
    function openBrowserAtRoot() {
        state.browseAtRoot = true;
        state.browseDir   = null;
        UI.showView('view-browse'); state.view = 'browse';
        document.getElementById('browse-title').textContent = 'Storage';
        document.getElementById('browse-path').textContent = '/';

        Browser.listRoots(function (err, roots) {
            var ul = document.getElementById('browse-list');
            ul.innerHTML = '';
            if (err) {
                ul.innerHTML = '<li><span class="icon">!</span><span class="name">' +
                               err.message + '</span></li>';
                return;
            }
            if (!roots.length) {
                ul.innerHTML = '<li><span class="icon">i</span>'
                             + '<span class="name">No accessible storage found.</span></li>';
                return;
            }
            roots.forEach(function (r, i) {
                var li = document.createElement('li');
                li.dataset.tag = 'root-' + i;
                li.dataset.idx = i;
                li.innerHTML  =
                    '<span class="icon">▸</span>' +
                    '<span class="name">' + escapeHtml(r.name) + '</span>' +
                    '<span class="meta">' + escapeHtml(r.fullPath) + '</span>';
                li.addEventListener('click', function () {
                    state.browseAtRoot = false;
                    listInto(r.dir);
                });
                ul.appendChild(li);
            });
            UI.refreshFocusables(); UI.focusOn(ul.firstElementChild);
        });
    }

    function listInto(dir) {
        if (!dir) return;
        state.browseDir = dir;
        document.getElementById('browse-title').textContent = dir.name || 'Folder';
        document.getElementById('browse-path').textContent = dir.fullPath;

        Browser.listDir(dir, function (err, entries) {
            var ul = document.getElementById('browse-list');
            ul.innerHTML = '';
            if (err) {
                ul.innerHTML = '<li><span class="icon">!</span><span class="name">'
                             + err.message + '</span></li>';
                return;
            }
            entries.forEach(function (e) {
                if (e.isDir === false && !e.playable) return; // hide non-media files
                var li = document.createElement('li');
                li.dataset.uri = e.uri || '';
                li.dataset.dir = e.isDir ? '1' : '0';
                li.innerHTML =
                    '<span class="icon">' + (e.isDir ? '📁' : '🎬') + '</span>' +
                    '<span class="name">' + escapeHtml(e.name) + '</span>' +
                    (e.isDir ? '' :
                        '<span class="meta">' + Browser.humanSize(e.size) + '</span>');
                li.addEventListener('click', function () {
                    if (e.isDir) listInto(e.file);
                    else playUri(e.uri, e.name);
                });
                ul.appendChild(li);
            });
            UI.refreshFocusables();
            UI.focusOn(ul.firstElementChild);
        });
    }

    function browseUp() {
        if (state.browseAtRoot) { backToHome(); return; }
        var p = Browser.parentOf(state.browseDir);
        if (!p) { openBrowserAtRoot(); return; }
        listInto(p);
    }

    function openRecent() {
        var list = getRecent();
        if (!list.length) { UI.toast('No recent items'); return; }
        UI.showView('view-browse'); state.view = 'browse'; state.browseAtRoot = true;
        document.getElementById('browse-title').textContent = 'Recently Played';
        document.getElementById('browse-path').textContent = '';
        var ul = document.getElementById('browse-list'); ul.innerHTML = '';
        list.forEach(function (item) {
            var li = document.createElement('li');
            li.innerHTML = '<span class="icon">★</span>' +
                           '<span class="name">' + escapeHtml(item.title) + '</span>' +
                           '<span class="meta">' + escapeHtml(item.uri) + '</span>';
            li.addEventListener('click', function () { playUri(item.uri, item.title); });
            ul.appendChild(li);
        });
        UI.refreshFocusables();
        UI.focusOn(ul.firstElementChild);
    }

    /* ── Common: open a URI in player view ────────────────────────── */
    function playUri(uri, title) {
        if (typeof Debug !== 'undefined') Debug.player('playUri uri=' + uri + '  title=' + title);
        state.playingUri = uri;
        state.playingTitle = title || uri;
        UI.showView('view-player'); state.view = 'player';
        if (typeof Debug !== 'undefined') Debug.view('player');

        document.getElementById('osd-title').textContent = title || uri;
        document.getElementById('osd-top').classList.remove('hidden');
        document.getElementById('osd-bottom').classList.remove('hidden');
        showSpinner('Opening…');
        hideError();

        // Need to defer slightly so the player object is laid out before
        // setDisplayRect — otherwise we get a 0×0 display.
        setTimeout(function () {
            Player.setDisplayRect();
            Player.open(uri, { title: title });
        }, 50);

        pushRecent({ uri: uri, title: title || uri });
        scheduleOSDHide();
    }

    function backToHome() {
        if (typeof Debug !== 'undefined') Debug.view('home');
        Player.stop();
        state.view = 'home';
        UI.showView('view-home');
        hideError();
        document.getElementById('osd-top').classList.add('hidden');
        document.getElementById('osd-bottom').classList.add('hidden');
        closeTrackMenu();
    }

    /* ── OSD show/hide ────────────────────────────────────────────── */
    var osdHideTimer = null;
    function showOSD(visible) {
        document.getElementById('osd-top').classList.toggle('hidden', !visible);
        document.getElementById('osd-bottom').classList.toggle('hidden', !visible);
        if (visible) UI.refreshFocusables();
    }
    function scheduleOSDHide() {
        clearTimeout(osdHideTimer);
        osdHideTimer = setTimeout(function () { showOSD(false); }, 5000);
    }
    function flashOSD() { showOSD(true); scheduleOSDHide(); }

    function showSpinner(msg) {
        var sp = document.getElementById('spinner');
        sp.querySelector('.spinner-text').textContent = msg || 'Loading…';
        sp.classList.remove('hidden');
    }
    function hideSpinner() { document.getElementById('spinner').classList.add('hidden'); }

    function showError(msg) {
        document.getElementById('error-msg').textContent = msg;
        document.getElementById('error-overlay').classList.remove('hidden');
        hideSpinner();
        UI.refreshFocusables();
        var btn = document.querySelector('#error-overlay .btn');
        if (btn) UI.focusOn(btn);
    }
    function hideError() {
        document.getElementById('error-overlay').classList.add('hidden');
    }

    function updatePlayPauseButton(state) {
        var btn = document.getElementById('btn-playpause');
        if (state === 'playing') btn.textContent = '⏸';
        else                     btn.textContent = '▶';
    }

    function updateProgress(timeMs, durMs) {
        document.getElementById('time-current').textContent  = fmtTime(timeMs);
        document.getElementById('time-duration').textContent = fmtTime(durMs);
        var pct = (durMs && durMs > 0) ? Math.min(100, (timeMs / durMs) * 100) : 0;
        document.getElementById('progress-fill').style.width = pct.toFixed(1) + '%';
    }

    function fmtTime(ms) {
        if (typeof ms !== 'number' || isNaN(ms) || ms < 0) return '00:00';
        var s = Math.floor(ms / 1000);
        var h = Math.floor(s / 3600); s -= h * 3600;
        var m = Math.floor(s / 60);   s -= m * 60;
        var p = function (n) { return n < 10 ? '0' + n : '' + n; };
        return (h ? p(h) + ':' : '') + p(m) + ':' + p(s);
    }

    /* ── Track menu ───────────────────────────────────────────────── */
    function openTrackMenu() {
        var t = Player.getTracks();
        var aUL = document.getElementById('audio-tracks');
        var sUL = document.getElementById('subtitle-tracks');
        aUL.innerHTML = ''; sUL.innerHTML = '';
        if (!t.audio.length) aUL.innerHTML = '<li class="muted">No audio tracks</li>';
        t.audio.forEach(function (tr) {
            var li = document.createElement('li');
            li.textContent = 'Audio #' + tr.index + ' — ' + (tr.extra || 'unnamed');
            li.addEventListener('click', function () { Player.setAudioTrack(tr.index); UI.toast('Audio set'); });
            aUL.appendChild(li);
        });
        if (!t.subtitle.length) sUL.innerHTML = '<li class="muted">No subtitle tracks</li>';
        t.subtitle.forEach(function (tr) {
            var li = document.createElement('li');
            li.textContent = 'Subtitle #' + tr.index + ' — ' + (tr.extra || 'unnamed');
            li.addEventListener('click', function () { Player.setSubtitleTrack(tr.index); UI.toast('Subtitle set'); });
            sUL.appendChild(li);
        });
        document.getElementById('track-menu').classList.remove('hidden');
        UI.refreshFocusables();
        var first = document.querySelector('#track-menu .focused, #track-menu li, #track-menu button');
        if (first) UI.focusOn(first);
    }
    function closeTrackMenu() {
        document.getElementById('track-menu').classList.add('hidden');
        UI.refreshFocusables();
    }

    /* ── Global remote key dispatcher ─────────────────────────────── */
    function globalKeyHandler(code, ev) {
        var K = Remote.KEY;
        if (typeof Debug !== 'undefined') Debug.key('code=' + code + ' view=' + state.view);

        // URL input view: let typing flow through except on RETURN/Enter.
        if (state.view === 'url') {
            if (code === K.BACK) { backToHome(); return true; }
            if (code === K.ENTER && document.activeElement &&
                document.activeElement.id === 'url-input') {
                handleAction('open-current-url');
                return true;
            }
        }

        switch (code) {
            case K.UP:    UI.moveFocus('up');    return true;
            case K.DOWN:  UI.moveFocus('down');  return true;
            case K.LEFT:
                if (state.view === 'player') { Player.seekRel(-10000); flashOSD(); return true; }
                UI.moveFocus('left');  return true;
            case K.RIGHT:
                if (state.view === 'player') { Player.seekRel( 10000); flashOSD(); return true; }
                UI.moveFocus('right'); return true;
            case K.ENTER:
                if (state.view === 'player') { flashOSD(); return true; }
                UI.activateFocused();  return true;
            case K.BACK:
                if (state.view === 'browse') { browseUp(); return true; }
                if (state.view === 'player') { backToHome(); return true; }
                if (state.view === 'url')    { backToHome(); return true; }
                return false; /* let TV handle EXIT-from-home */
            case K.PLAY:
            case K.PAUSE:
            case K.PLAYPAUSE:
                if (state.view === 'player') { Player.togglePause(); flashOSD(); return true; }
                return false;
            case K.STOP:
                if (state.view === 'player') { Player.stop(); backToHome(); return true; }
                return false;
            case K.REWIND:
                if (state.view === 'player') { Player.seekRel(-30000); flashOSD(); return true; }
                return false;
            case K.FF:
                if (state.view === 'player') { Player.seekRel( 30000); flashOSD(); return true; }
                return false;
        }
        return false;
    }

    /* ── Helpers ──────────────────────────────────────────────────── */
    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    if (document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', init);
    else
        init();

})();

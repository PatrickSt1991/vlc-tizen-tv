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
                /* Don't clear the watchdog here — it needs to keep running so
                 * it can detect the "PLAYING but stuck at time=0" case.  The
                 * watchdog disarms itself once it sees time advancing. */
                hideSpinner();
                showOSD(true);
                scheduleOSDHide();
                applyLanguagePreferences();
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
            if (Settings.get('repeatMode') === 'one' && state.playingUri) {
                if (typeof Debug !== 'undefined') Debug.player('oncomplete: repeating');
                Player.seekTo(0);
                Player.play();
                return;
            }
            UI.toast('Playback finished');
            backToHome();
        });

        // Reflow display rect on size changes
        window.addEventListener('resize', Player.setDisplayRect);

        UI.showView('view-home');
        updateRepeatButton();  // reflect saved repeat preference on OSD
    }

    /* ── Action dispatcher ────────────────────────────────────────── */
    function handleAction(action, el) {
        if (typeof Debug !== 'undefined') Debug.action(action);
        switch (action) {
            case 'open-url':           UI.showView('view-url'); state.view = 'url'; break;
            case 'browse-usb':         openBrowserAtRoot(); break;
            case 'browse-recent':      openRecent(); break;
            case 'open-settings':      openSettings(); break;
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
            case 'toggle-repeat':      toggleRepeat(); break;
            case 'open-track-menu':    openTrackMenu(); break;
            case 'close-track-menu':   closeTrackMenu(); break;
            case 'setting-audio-lang':    openLangPicker('audioLang',    'Preferred audio language', LanguageList.forAudio());    break;
            case 'setting-subtitle-lang': openLangPicker('subtitleLang', 'Preferred subtitle language', LanguageList.forSubtitle()); break;
            case 'setting-repeat-mode':   openRepeatPicker(); break;
            case 'close-picker':       closePicker(); break;
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
                var pretty = prettifyRootName(r.name);
                var isUsb  = /removable|usb/i.test(r.name);
                li.innerHTML  =
                    '<span class="icon">' + (isUsb ? '💾' : '📁') + '</span>' +
                    '<span class="name">' + escapeHtml(pretty) + '</span>' +
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
                var subBadge = (e.subtitles && e.subtitles.length)
                    ? '<span class="meta">CC ×' + e.subtitles.length + '</span>'
                    : '';
                li.innerHTML =
                    '<span class="icon">' + (e.isDir ? '📁' : '🎬') + '</span>' +
                    '<span class="name">' + escapeHtml(e.name) + '</span>' +
                    subBadge +
                    (e.isDir ? '' :
                        '<span class="meta">' + Browser.humanSize(e.size) + '</span>');
                li.addEventListener('click', function () {
                    if (e.isDir) listInto(e.file);
                    else playUri(e.uri, e.name, { subtitles: e.subtitles });
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
    var openWatchdog = null;
    function playUri(uri, title, opts) {
        opts = opts || {};
        if (typeof Debug !== 'undefined') Debug.player('playUri uri=' + uri + '  title=' + title);
        // Reset the once-per-file gate so applyLanguagePreferences runs for
        // the new file (and not for the previous file).
        prefsAppliedFor = null;
        state.playingUri = uri;
        state.playingTitle = title || uri;
        UI.showView('view-player'); state.view = 'player';
        if (typeof Debug !== 'undefined') Debug.view('player');

        document.getElementById('osd-title').textContent = title || uri;
        document.getElementById('osd-top').classList.remove('hidden');
        document.getElementById('osd-bottom').classList.remove('hidden');
        showSpinner('Opening…');
        hideError();

        // Defer slightly so the <object> element is laid out before AVPlay
        // tries to bind to it.  No need to call setDisplayRect here — AVPlay
        // is in an idle state before open() and would error with INVALID_STATE.
        // The proper setDisplayRect happens after prepareAsync succeeds.
        setTimeout(function () {
            Player.open(uri, {
                title:     title,
                subtitles: opts.subtitles || []
            });
        }, 50);

        // Watchdog: detect two failure modes —
        //   1. AVPlay never reaches PLAYING within 20 s (stuck in IDLE/READY)
        //   2. AVPlay reports PLAYING but currentTime stays at 0 for 10 s
        //      (codec unsupported — most often HEVC Main10 on a TV that only
        //      supports HEVC Main8).
        clearInterval(openWatchdog);
        var watchdogStart = Date.now();
        openWatchdog = setInterval(function () {
            var elapsed = Date.now() - watchdogStart;
            var state   = Player.state();
            var time    = Player.currentTime();

            if (elapsed > 20000 && state !== 'PLAYING' && state !== 'PAUSED') {
                clearInterval(openWatchdog);
                showError('Stuck loading after 20 s.  AVPlay state: ' + state +
                          '.  The codec, container, or source may not be supported.');
                return;
            }
            if (elapsed > 10000 && state === 'PLAYING' && (!time || time === 0)) {
                clearInterval(openWatchdog);
                showError('Playback stalled: AVPlay reports playing but the playhead ' +
                          'isn\'t advancing.  This usually means the codec inside the ' +
                          'file isn\'t supported by your TV (most often HEVC Main10 / ' +
                          '10-bit colour on a TV that only handles HEVC Main8).');
                return;
            }
            if (state === 'PLAYING' && time > 0) {
                // We're actually progressing — disarm.
                clearInterval(openWatchdog);
            }
        }, 1000);

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
        var wasHidden = document.getElementById('osd-bottom').classList.contains('hidden');
        document.getElementById('osd-top').classList.toggle('hidden', !visible);
        document.getElementById('osd-bottom').classList.toggle('hidden', !visible);
        if (visible) {
            UI.refreshFocusables();
            // Auto-focus the play-pause button when the OSD first appears, so
            // Up/Down navigation has an anchor and ENTER activates something.
            if (wasHidden) {
                var pp = document.getElementById('btn-playpause');
                if (pp) UI.focusOn(pp);
            }
        }
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
        // Hide all sibling overlays so the error stays the only focusable thing
        document.getElementById('osd-top').classList.add('hidden');
        document.getElementById('osd-bottom').classList.add('hidden');
        document.getElementById('track-menu').classList.add('hidden');
        hideSpinner();
        clearInterval(openWatchdog);

        // Hint for opaque codec-not-supported errors
        var hint = '';
        var uri = state.playingUri || '';
        var isMkv = /\.mkv($|\?)/i.test(uri) || /MKV not supported/i.test(msg);

        if (isMkv) {
            // Replace the raw error with a clear headline; the hint carries
            // the actionable detail.
            msg = 'MKV files aren\'t supported on this TV';
            hint = 'The TV\'s WebView can\'t decode MKV containers directly. ' +
                   'Remux to MP4 — no quality loss, takes seconds:\n\n' +
                   '    ffmpeg -i input.mkv -c copy output.mp4\n\n' +
                   'If the audio codec is FLAC or DTS, also re-encode audio:\n\n' +
                   '    ffmpeg -i input.mkv -c:v copy -c:a aac -b:a 192k output.mp4';
        } else if (/unknown error|not supported|invalid|stuck loading|unsupported source/i.test(msg)) {
            hint = 'The file or stream may use a codec or container that this TV can\'t ' +
                   'decode (HEVC 10-bit, AV1, DTS-HD MA, VP9 Profile 2, etc.). ' +
                   'For local files, remux to MP4 with: ffmpeg -i input.ext -c copy output.mp4';
        } else if (/connection|network|timeout/i.test(msg)) {
            hint = 'The TV couldn\'t reach the source.  Check the URL, the server is up, ' +
                   'and your TV has network access.';
        }

        document.getElementById('error-title').textContent = msg;
        document.getElementById('error-hint').textContent  = hint;
        document.getElementById('error-overlay').classList.remove('hidden');

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

    /* ── Settings view ────────────────────────────────────────────── */
    function openSettings() {
        UI.showView('view-settings'); state.view = 'settings';
        refreshSettingsValues();
        renderTvInfo();
    }
    function refreshSettingsValues() {
        document.getElementById('setting-audio-lang-value').textContent    = LanguageList.nameFor(Settings.get('audioLang'));
        document.getElementById('setting-subtitle-lang-value').textContent = LanguageList.nameFor(Settings.get('subtitleLang'));
        document.getElementById('setting-repeat-mode-value').textContent   = (Settings.get('repeatMode') === 'one') ? 'Repeat one' : 'Off';
        // Mirror repeat state to the OSD button if visible
        updateRepeatButton();
    }
    function renderTvInfo() {
        var box  = document.getElementById('tvinfo');
        var pInfo = TvInfo.getProductInfo();
        var codecs = TvInfo.getCodecs();
        var ua = TvInfo.getUA();

        // Kick off the async build query; we render placeholder rows first.
        TvInfo.getBuild(function (b) {
            var rows = [];
            function row(k, v) { rows.push('<div class="row"><div class="k">' + escapeHtml(k) + '</div><div class="v">' + escapeHtml(v || '—') + '</div></div>'); }
            row('Model',            pInfo.realModel || b.model || '—');
            row('Marketing name',   pInfo.tvName    || b.buildDescription || '—');
            row('Firmware',         pInfo.firmwareVersion || b.buildVersion || '—');
            row('Build release',    b.buildReleaseDate || '—');
            row('Manufacturer',     b.manufacturer || '—');
            row('User-Agent',       ua);

            var codecHtml = '<h3>HTML5 video codec support</h3><div class="codecs">';
            Object.keys(codecs).forEach(function (name) {
                var status = codecs[name];
                var cls = status === 'probably' ? 'ok' : status === 'maybe' ? 'maybe' : 'no';
                var label = status === 'probably' ? '✓ Supported' :
                            status === 'maybe'    ? '? Possibly' :
                                                    '✗ Not supported';
                codecHtml += '<div class="codec"><span class="name">' + escapeHtml(name) + '</span>' +
                             '<span class="status ' + cls + '">' + label + '</span></div>';
            });
            codecHtml += '</div>';

            codecHtml += '<h3>Streaming &amp; protocols (via Samsung AVPlay)</h3><div class="codecs">';
            codecHtml += '<div class="codec"><span class="name">HLS / DASH</span>' +
                         '<span class="status ok">✓ Supported</span></div>';
            codecHtml += '<div class="codec"><span class="name">RTSP / RTMP</span>' +
                         '<span class="status ok">✓ Supported</span></div>';
            codecHtml += '<div class="codec"><span class="name">USB local files</span>' +
                         '<span class="status ok">✓ Via HTML5 video</span></div>';
            codecHtml += '<div class="codec"><span class="name">MKV container</span>' +
                         '<span class="status maybe">? Remux to MP4</span></div>';
            codecHtml += '</div>';

            box.innerHTML = rows.join('') + codecHtml;
        });
    }

    /* ── Picker (generic option list, used for settings choices) ──── */
    var pickerSetting = null;        // which setting we're editing
    function openPicker(title, options, currentValue, onPick) {
        document.getElementById('picker-title').textContent = title;
        var ul = document.getElementById('picker-options');
        ul.innerHTML = '';
        options.forEach(function (opt) {
            var li = document.createElement('li');
            li.tabIndex = 0;
            li.textContent = opt.name;
            if (opt.code === currentValue) li.classList.add('active');
            li.addEventListener('click', function () {
                onPick(opt.code);
                closePicker();
            });
            ul.appendChild(li);
        });
        document.getElementById('picker').classList.remove('hidden');
        UI.refreshFocusables();
        var first = document.querySelector('#picker .active') ||
                    document.querySelector('#picker li, #picker button');
        if (first) UI.focusOn(first);
    }
    function closePicker() {
        document.getElementById('picker').classList.add('hidden');
        pickerSetting = null;
        UI.refreshFocusables();
    }
    function openLangPicker(settingKey, title, options) {
        pickerSetting = settingKey;
        var cur = Settings.get(settingKey);
        openPicker(title, options, cur, function (val) {
            Settings.set(settingKey, val);
            refreshSettingsValues();
            UI.toast(title + ': ' + LanguageList.nameFor(val));
        });
    }
    function openRepeatPicker() {
        pickerSetting = 'repeatMode';
        var cur = Settings.get('repeatMode');
        openPicker('Repeat mode', [
            { code: 'off', name: 'Off' },
            { code: 'one', name: 'Repeat current file' }
        ], cur, function (val) {
            Settings.set('repeatMode', val);
            refreshSettingsValues();
            UI.toast('Repeat: ' + (val === 'one' ? 'On' : 'Off'));
        });
    }

    /* ── Repeat toggle from the OSD ───────────────────────────────── */
    function toggleRepeat() {
        var next = Settings.get('repeatMode') === 'one' ? 'off' : 'one';
        Settings.set('repeatMode', next);
        updateRepeatButton();
        UI.toast('Repeat: ' + (next === 'one' ? 'On' : 'Off'));
    }
    function updateRepeatButton() {
        var btn = document.getElementById('btn-repeat');
        if (!btn) return;
        btn.classList.toggle('repeat-on', Settings.get('repeatMode') === 'one');
    }

    /* ── Track menu ───────────────────────────────────────────────── */
    function openTrackMenu() {
        var t = Player.getTracks();
        var aUL = document.getElementById('audio-tracks');
        var sUL = document.getElementById('subtitle-tracks');
        aUL.innerHTML = ''; sUL.innerHTML = '';

        if (!t.audio.length) {
            aUL.innerHTML = '<li class="muted">Only one audio track</li>';
        } else {
            t.audio.forEach(function (tr) {
                var li = document.createElement('li');
                li.textContent = tr.name;
                if (tr.active) li.classList.add('active');
                li.addEventListener('click', function () {
                    Player.setAudioTrack(tr.index);
                    UI.toast('Audio: ' + tr.name);
                    closeTrackMenu();
                });
                aUL.appendChild(li);
            });
        }

        // Subtitle list always has at least the "Off" entry from getTracks()
        t.subtitle.forEach(function (tr) {
            var li = document.createElement('li');
            li.textContent = tr.name;
            if (tr.active) li.classList.add('active');
            li.addEventListener('click', function () {
                Player.setSubtitleTrack(tr.off ? -1 : tr.index);
                UI.toast('Subtitle: ' + tr.name);
                closeTrackMenu();
            });
            sUL.appendChild(li);
        });

        document.getElementById('track-menu').classList.remove('hidden');
        UI.refreshFocusables();
        // Land on the currently-active track if any, else the first real (non-
        // muted) track item, else the Close button.
        var first = document.querySelector('#track-menu .active') ||
                    document.querySelector('#track-menu .track-section li:not(.muted)') ||
                    document.querySelector('#track-menu button');
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

        // When the error overlay is up, route ALL navigation/activation to it
        // (no seeking, no OSD flashing — the only thing on screen that matters
        // is the "Back to Home" button).
        var errorUp = !document.getElementById('error-overlay').classList.contains('hidden');

        // Track menu / settings picker open? Routes through normal focus.
        var trackMenuOpen = !document.getElementById('track-menu').classList.contains('hidden');
        var pickerOpen    = !document.getElementById('picker').classList.contains('hidden');
        // OSD currently visible? Determines whether keys navigate within OSD
        // or perform seek shortcuts.
        var osdVisible = !document.getElementById('osd-bottom').classList.contains('hidden');

        switch (code) {
            // All four arrows in player view navigate between OSD buttons.
            // Seek is on the dedicated FF / RW media keys instead, so arrows
            // don't fight navigation with seeking.
            case K.UP:
                if (state.view === 'player' && !errorUp && !trackMenuOpen) {
                    if (!osdVisible) { flashOSD(); return true; }
                    UI.moveFocusCyclic(-1);
                    flashOSD();
                    return true;
                }
                if (state.view === 'settings' && !pickerOpen) {
                    scrollSettingsIfNoFocusMove(-200, 'up');
                    return true;
                }
                UI.moveFocus('up');
                return true;
            case K.DOWN:
                if (state.view === 'player' && !errorUp && !trackMenuOpen) {
                    if (!osdVisible) { flashOSD(); return true; }
                    UI.moveFocusCyclic(+1);
                    flashOSD();
                    return true;
                }
                if (state.view === 'settings' && !pickerOpen) {
                    scrollSettingsIfNoFocusMove(+200, 'down');
                    return true;
                }
                UI.moveFocus('down');
                return true;
            case K.LEFT:
                if (state.view === 'player' && !errorUp && !trackMenuOpen) {
                    if (!osdVisible) { flashOSD(); return true; }
                    UI.moveFocusCyclic(-1);    // previous OSD button
                    flashOSD();
                    return true;
                }
                UI.moveFocus('left');  return true;
            case K.RIGHT:
                if (state.view === 'player' && !errorUp && !trackMenuOpen) {
                    if (!osdVisible) { flashOSD(); return true; }
                    UI.moveFocusCyclic(+1);    // next OSD button
                    flashOSD();
                    return true;
                }
                UI.moveFocus('right'); return true;
            case K.ENTER:
                // In player view: OK activates the focused OSD button if the OSD
                // is up (so Stop / CC-Audio / etc. are reachable).  If the OSD
                // is hidden, OK just brings it up.
                if (state.view === 'player' && !errorUp && !trackMenuOpen) {
                    if (!osdVisible) { flashOSD(); return true; }
                    if (!UI.activateFocused()) flashOSD();
                    return true;
                }
                UI.activateFocused();  return true;
            case K.BACK:
                if (pickerOpen)                 { closePicker();     return true; }
                if (trackMenuOpen)              { closeTrackMenu();  return true; }
                if (errorUp)                    { backToHome();      return true; }
                if (state.view === 'browse')    { browseUp();        return true; }
                if (state.view === 'player')    { backToHome();      return true; }
                if (state.view === 'url')       { backToHome();      return true; }
                if (state.view === 'settings')  { backToHome();      return true; }
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

    /* ── Auto-apply preferred audio + subtitle language ─────────────
     * Called after the player reaches state=PLAYING so the AVPlay/HTML5
     * track list is populated.  Finds the first track whose name (or, for
     * HTML5 external subs, lang tag) matches the preferred ISO code and
     * activates it.  Subtitle 'off' explicitly disables.  No-op if the
     * preference is empty (Auto). */
    var prefsAppliedFor = null;
    function applyLanguagePreferences() {
        // Only apply once per file to avoid clobbering manual selections
        if (prefsAppliedFor === state.playingUri) return;
        prefsAppliedFor = state.playingUri;

        var prefAudio = Settings.get('audioLang');
        var prefSub   = Settings.get('subtitleLang');
        var tracks    = Player.getTracks();

        // Audio: only act if user has a non-empty preference
        if (prefAudio) {
            for (var i = 0; i < tracks.audio.length; i++) {
                var t = tracks.audio[i];
                var nm = (t.name || '').toLowerCase();
                if (nm.indexOf(prefAudio.toLowerCase()) >= 0) {
                    Player.setAudioTrack(t.index);
                    if (typeof Debug !== 'undefined') Debug.player('applied audio pref ' + prefAudio + ' → ' + t.name);
                    break;
                }
            }
        }

        // Subtitle: 'off' explicit, '' auto (no action), code → match
        if (prefSub === 'off') {
            Player.setSubtitleTrack(-1);
        } else if (prefSub) {
            for (var j = 0; j < tracks.subtitle.length; j++) {
                var st = tracks.subtitle[j];
                if (st.off) continue;
                var sn = (st.name || '').toLowerCase();
                if (sn.indexOf(prefSub.toLowerCase()) >= 0 ||
                    sn.indexOf('[' + prefSub.toLowerCase() + ']') >= 0) {
                    Player.setSubtitleTrack(st.index);
                    if (typeof Debug !== 'undefined') Debug.player('applied subtitle pref ' + prefSub + ' → ' + st.name);
                    break;
                }
            }
        }
    }

    /* On the settings view, after the last focusable row there's a TV-info
     * panel that has no focusables.  Up/Down should first try a normal focus
     * move; if focus didn't change (because there's nothing in that direction),
     * we scroll the settings-content scroll container instead so the user can
     * read past the bottom of the info panel. */
    function scrollSettingsIfNoFocusMove(dy, dir) {
        var before = document.querySelector('.focused');
        UI.moveFocus(dir);
        var after = document.querySelector('.focused');
        if (before === after) {
            var c = document.querySelector('.settings-content');
            if (c) c.scrollBy({ top: dy, behavior: 'smooth' });
        }
    }

    /* ── Helpers ──────────────────────────────────────────────────── */
    function prettifyRootName(name) {
        if (!name) return 'Unknown';
        if (/^removable.*/i.test(name)) return 'USB Drive';
        if (/^usb/i.test(name)) return 'USB Drive';
        if (name === 'downloads') return 'Downloads';
        if (name === 'videos')    return 'Videos';
        if (name === 'music')     return 'Music';
        if (name === 'images')    return 'Pictures';
        if (name === 'documents') return 'Documents';
        return name.charAt(0).toUpperCase() + name.slice(1);
    }

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

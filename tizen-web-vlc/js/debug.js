/* Debug telemetry — fire-and-forget HTTP POSTs to a PC listener.
 *
 * The endpoint is configured at runtime under Settings → Debug logging and
 * persisted in localStorage, so anyone can point it at their own machine
 * instead of editing a hard-coded IP. It ships DISABLED: nothing is sent
 * until you turn it on and enter your listener's IP. (A simple HTTP listener
 * on the chosen port — e.g. the PowerShell one on 9999 — receives each line.)
 */

var Debug = (function () {
    var CFG_KEY = 'vlctv_debug_v1';
    var startTs = Date.now();
    var seq     = 0;

    function loadCfg() {
        try {
            var c = JSON.parse(localStorage.getItem(CFG_KEY) || '{}');
            return { enabled: !!c.enabled, host: c.host || '', port: c.port || 9999 };
        } catch (e) {
            return { enabled: false, host: '', port: 9999 };
        }
    }
    var cfg = loadCfg();

    function active() { return cfg.enabled && !!cfg.host; }
    function url()    { return 'http://' + cfg.host + ':' + cfg.port + '/'; }

    function ts() {
        var t = (Date.now() - startTs) / 1000;
        return '[' + t.toFixed(3) + ']';
    }

    function send(tag, msg) {
        if (!active()) return;
        seq++;
        var payload = ts() + ' #' + seq + ' [' + tag + '] ' +
                      (typeof msg === 'string' ? msg : JSON.stringify(msg));
        var dest = url();
        try {
            var x = new XMLHttpRequest();
            x.open('POST', dest, true);
            x.setRequestHeader('Content-Type', 'text/plain');
            x.send(payload);
        } catch (e) {
            try {
                var img = new Image();
                img.src = dest + '?msg=' + encodeURIComponent(payload) + '&_=' + Date.now();
            } catch (e2) {}
        }
    }

    /* Convenience helpers — every "category" gets its own short tag */
    function info (m) { send('INFO',   m); }
    function warn (m) { send('WARN',   m); }
    function error(m) { send('ERROR',  m); }
    function view (m) { send('VIEW',   m); }
    function action(m){ send('ACTION', m); }
    function player(m){ send('PLAYER', m); }
    function browse(m){ send('BROWSE', m); }
    function key   (m){ send('KEY',    m); }

    /* Update + persist the endpoint config (called by the settings form). */
    function configure(c) {
        cfg = {
            enabled: !!(c && c.enabled),
            host: (c && c.host) ? String(c.host).trim() : '',
            port: (c && parseInt(c.port, 10)) || 9999
        };
        try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) {}
    }
    function getConfig() { return { enabled: cfg.enabled, host: cfg.host, port: cfg.port }; }

    /* Wire the Settings form (toggle + IP + port + Save). */
    function wireForm() {
        var save = document.getElementById('dbg-save');
        if (!save) return;
        var hostEl = document.getElementById('dbg-host');
        var portEl = document.getElementById('dbg-port');
        var enBtn  = document.getElementById('dbg-enabled');
        var enVal  = document.getElementById('dbg-enabled-val');
        if (hostEl) hostEl.value = cfg.host || '';
        if (portEl) portEl.value = cfg.port || 9999;
        var enState = cfg.enabled;
        function paint() { if (enVal) enVal.textContent = enState ? 'On' : 'Off'; }
        paint();
        if (enBtn) enBtn.addEventListener('click', function () { enState = !enState; paint(); });
        save.addEventListener('click', function () {
            configure({ enabled: enState,
                        host: hostEl ? hostEl.value : '',
                        port: portEl ? portEl.value : 9999 });
            if (typeof UI !== 'undefined' && UI.toast) UI.toast('Debug settings saved');
            if (active()) send('INFO', 'debug logging enabled from settings → ' + url());
        });
    }
    if (document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', wireForm);
    else
        wireForm();

    /* Capture unhandled JS errors automatically */
    window.addEventListener('error', function (ev) {
        send('JSERR',
             (ev.message || '?') + ' @ ' + (ev.filename || '?') + ':' + ev.lineno);
    });
    window.addEventListener('unhandledrejection', function (ev) {
        send('JSREJECT',
             ev.reason && ev.reason.message ? ev.reason.message : String(ev.reason));
    });

    /* Boot banner — confirms the app loaded + the build it's from (only sent
     * when logging is enabled and an endpoint is set). */
    send('BOOT',
         'VLC TV starting; UA=' + navigator.userAgent +
         '; href=' + location.href);

    return {
        send: send,
        info: info, warn: warn, error: error,
        view: view, action: action,
        player: player, browse: browse, key: key,
        configure: configure, getConfig: getConfig,
        get enabled() { return cfg.enabled; }
    };
})();

/* Debug telemetry — fire-and-forget HTTP POSTs to the PC's listener.
 *
 * Set DEBUG = false (or remove this file's <script> tag) for production.
 * The PowerShell HTTP listener you already have on port 9999 will receive
 * each line — just like the canary did.
 */

var Debug = (function () {
    var DEBUG    = true;
    var PC_URL   = 'http://192.168.2.22:9999/';
    var startTs  = Date.now();
    var seq      = 0;

    function ts() {
        var t = (Date.now() - startTs) / 1000;
        return '[' + t.toFixed(3) + ']';
    }

    function send(tag, msg) {
        if (!DEBUG) return;
        seq++;
        var payload = ts() + ' #' + seq + ' [' + tag + '] ' +
                      (typeof msg === 'string' ? msg : JSON.stringify(msg));
        try {
            var x = new XMLHttpRequest();
            x.open('POST', PC_URL, true);
            x.setRequestHeader('Content-Type', 'text/plain');
            x.send(payload);
        } catch (e) {
            try {
                var img = new Image();
                img.src = PC_URL + '?msg=' + encodeURIComponent(payload) + '&_=' + Date.now();
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

    /* Capture unhandled JS errors automatically */
    window.addEventListener('error', function (ev) {
        send('JSERR',
             (ev.message || '?') + ' @ ' + (ev.filename || '?') + ':' + ev.lineno);
    });
    window.addEventListener('unhandledrejection', function (ev) {
        send('JSREJECT',
             ev.reason && ev.reason.message ? ev.reason.message : String(ev.reason));
    });

    /* Boot banner — confirms the app loaded + the build it's from */
    send('BOOT',
         'VLC TV starting; UA=' + navigator.userAgent +
         '; href=' + location.href);

    return {
        send: send,
        info: info, warn: warn, error: error,
        view: view, action: action,
        player: player, browse: browse, key: key,
        get enabled() { return DEBUG; }
    };
})();

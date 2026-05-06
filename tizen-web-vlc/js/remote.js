/* Remote-control key handling.
 *
 * Tizen TV remote keys arrive as standard `keydown` events on `window`, but
 * with TV-specific keyCodes.  Special media keys (Play/Pause/FF/RW) need to
 * be explicitly registered via tizen.tvinputdevice.registerKey() or they're
 * not delivered at all.  We register every media key up-front. */

var Remote = (function () {
    var KEY = {
        LEFT:   37,
        UP:     38,
        RIGHT:  39,
        DOWN:   40,
        ENTER:  13,
        BACK:   10009,
        EXIT:   10182,

        PLAY:   415,
        PAUSE:  19,
        STOP:   413,
        REWIND: 412,
        FF:     417,
        PLAYPAUSE: 10252,

        ZERO:   48, ONE: 49, TWO: 50, THREE: 51, FOUR: 52,
        FIVE: 53, SIX: 54, SEVEN: 55, EIGHT: 56, NINE: 57,

        VOL_UP: 447, VOL_DOWN: 448, MUTE: 449,
        CH_UP:  427, CH_DOWN: 428,
        RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406,
        INFO: 457, GUIDE: 458,

        MEDIA_PLAY: 415, MEDIA_PAUSE: 19, MEDIA_STOP: 413,
        MEDIA_REWIND: 412, MEDIA_FF: 417,
        MEDIA_RECORD: 416, MEDIA_PLAYPAUSE: 10252
    };

    /* Register media keys so they're delivered to our handler. */
    function registerMediaKeys() {
        if (typeof tizen === 'undefined' || !tizen.tvinputdevice) return;
        var keys = [
            'MediaPlay', 'MediaPause', 'MediaStop',
            'MediaRewind', 'MediaFastForward',
            'MediaPlayPause', 'MediaRecord',
            'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue',
            'Info', 'Guide',
            'ChannelUp', 'ChannelDown',
            'Exit',
        ];
        for (var i = 0; i < keys.length; i++) {
            try { tizen.tvinputdevice.registerKey(keys[i]); } catch (e) {}
        }
    }

    var listeners = [];

    function init() {
        registerMediaKeys();
        window.addEventListener('keydown', dispatch);
    }

    function dispatch(ev) {
        var code = ev.keyCode;
        for (var i = 0; i < listeners.length; i++) {
            if (listeners[i](code, ev) === true) {
                ev.preventDefault();
                ev.stopPropagation();
                return;
            }
        }
    }

    /* Listeners are tried in REVERSE registration order (most-recently-pushed
     * has priority — like a modal stack). */
    function push(fn) { listeners.unshift(fn); return fn; }
    function pop(fn) {
        var i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
    }

    return { KEY: KEY, init: init, push: push, pop: pop };
})();

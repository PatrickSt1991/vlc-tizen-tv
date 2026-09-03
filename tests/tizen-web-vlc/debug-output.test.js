'use strict';

var assert = require('assert');
var test   = require('node:test');
var fs     = require('fs');
var vm     = require('vm');
var path   = require('path');

var SRC = fs.readFileSync(
    path.join(__dirname, '../../tizen-web-vlc/js/debug.js'), 'utf8');

/* debug.js expects a browser; stub the parts it touches so what it writes to
 * the console and what it POSTs can be told apart without a TV. */
function loadDebug(saved) {
    var logged = [];
    var errored = [];
    var posts  = [];
    var store  = {};
    if (saved) store['vlctv_debug_v1'] = JSON.stringify(saved);

    var sandbox = {
        // Same shape Node gives a module: the export guard in debug.js only
        // fires when module.exports is already an object.
        module:  { exports: {} },
        console: {
            log:   function (line) { logged.push(line); },
            error: function (line) { errored.push(line); }
        },
        localStorage: {
            getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
            setItem: function (k, v) { store[k] = String(v); }
        },
        document: {
            readyState: 'complete',
            addEventListener: function () {},
            getElementById: function () { return null; }
        },
        window:    { addEventListener: function () {} },
        navigator: { userAgent: 'test' },
        location:  { href: 'file:///index.html' },
        XMLHttpRequest: function () {
            var req = this;
            this.open = function (method, dest) { req._dest = dest; };
            this.setRequestHeader = function () {};
            this.send = function (body) { posts.push({ dest: req._dest, body: body }); };
        },
        Image: function () {}
    };
    vm.createContext(sandbox);
    vm.runInContext(SRC, sandbox);

    return { Debug: sandbox.module.exports, logged: logged, errored: errored, posts: posts };
}

test('every line reaches the console without anything being configured', function () {
    // Apps2Samsung → Installed apps → Debug attaches DevTools; the lines have
    // to be there already, with no listener and nothing switched on.
    var d = loadDebug();
    assert.ok(d.logged.some(function (l) { return /\[BOOT\]/.test(l); }),
        'the boot banner should have been logged');

    d.Debug.player('opened a file');
    var last = d.logged[d.logged.length - 1];
    assert.ok(/^\[vlctv\]/.test(last), 'lines carry a filterable prefix: ' + last);
    assert.ok(/#\d+ \[PLAYER\] opened a file$/.test(last), last);
    assert.strictEqual(d.posts.length, 0, 'nothing should be posted while unconfigured');
});

test('warnings and errors go out as console errors', function () {
    var d = loadDebug();
    d.Debug.warn('slow read');
    d.Debug.error('gave up');
    d.Debug.info('fine');

    assert.strictEqual(d.errored.length, 2, 'WARN and ERROR belong in DevTools error filter');
    assert.ok(/\[WARN\] slow read$/.test(d.errored[0]));
    assert.ok(/\[ERROR\] gave up$/.test(d.errored[1]));
    assert.ok(/\[INFO\] fine$/.test(d.logged[d.logged.length - 1]));
});

test('the POST half only fires once it is turned on and given an address', function () {
    var d = loadDebug();
    d.Debug.configure({ enabled: true, host: '', port: 9999 });
    d.Debug.info('no address');
    assert.strictEqual(d.posts.length, 0);

    d.Debug.configure({ enabled: false, host: '192.168.1.50', port: 9999 });
    d.Debug.info('switched off');
    assert.strictEqual(d.posts.length, 0);

    d.Debug.configure({ enabled: true, host: '192.168.1.50', port: 9999 });
    d.Debug.info('both');
    assert.strictEqual(d.posts.length, 1);
    assert.strictEqual(d.posts[0].dest, 'http://192.168.1.50:9999/');
    assert.ok(/\[INFO\] both$/.test(d.posts[0].body));
    // The POST body carries no console prefix — that is DevTools' filter, not
    // part of the line.
    assert.ok(!/^\[vlctv\]/.test(d.posts[0].body), d.posts[0].body);
    // Every one of those calls still reached the console.
    assert.ok(d.logged.filter(function (l) { return /\[INFO\]/.test(l); }).length >= 3);
});

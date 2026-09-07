'use strict';

var assert = require('assert');
var test   = require('node:test');
var fs     = require('fs');
var vm     = require('vm');
var path   = require('path');

var SRC = fs.readFileSync(
    path.join(__dirname, '../../tizen-web-vlc/js/smb.js'), 'utf8');

/* smb.js expects a browser and a Debug module; stub both so what the Save
 * button stores and what it logs can be checked without a TV. */
function loadSmb(fields) {
    var store  = {};
    var lines  = [];
    var toasts = [];
    var handlers = {};
    var inputs = {};
    ['host', 'port', 'share', 'user', 'pass', 'domain'].forEach(function (k) {
        inputs['smb-' + k] = { value: (fields && fields[k]) || '' };
    });
    var buttons = {
        'smb-save': { addEventListener: function (ev, fn) { handlers.save = fn; } },
        'smb-anon': { addEventListener: function (ev, fn) { handlers.anon = fn; } },
        'smb-anon-val': { textContent: '' }
    };

    var sandbox = {
        module: { exports: {} },
        Debug:  { send: function (tag, msg) { lines.push('[' + tag + '] ' + msg); } },
        UI:     { toast: function (m) { toasts.push(m); } },
        localStorage: {
            getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
            setItem: function (k, v) { store[k] = String(v); }
        },
        document: {
            readyState: 'complete',
            addEventListener: function () {},
            getElementById: function (id) { return inputs[id] || buttons[id] || null; }
        },
        window: {},
        XMLHttpRequest: function () {
            this.open = function () {}; this.setRequestHeader = function () {}; this.send = function () {};
        }
    };
    vm.createContext(sandbox);
    vm.runInContext(SRC, sandbox);

    return {
        SMB: sandbox.module.exports,
        save: function () { handlers.save(); },
        saved: function () { return JSON.parse(store['vlctv_smb_v1'] || '{}'); },
        lines: lines,
        toasts: toasts
    };
}

test('normalizeServer accepts every spelling of a server a user is likely to type', function () {
    var raw = loadSmb().SMB.normalizeServer;
    // The object comes from the vm context, so copy its fields before comparing.
    var n = function (x) { var r = raw(x); return { host: r.host, port: r.port, share: r.share }; };
    assert.deepStrictEqual(n('192.168.1.10'),            { host: '192.168.1.10', port: 0,   share: '' });
    assert.deepStrictEqual(n('  nas.local:4450 '),       { host: 'nas.local',    port: 4450, share: '' });
    assert.deepStrictEqual(n('smb://nas/Media'),         { host: 'nas',          port: 0,   share: 'Media' });
    assert.deepStrictEqual(n('//nas/Media/Films'),       { host: 'nas',          port: 0,   share: 'Media' });
    assert.deepStrictEqual(n('\\\\nas\\Media'),          { host: 'nas',          port: 0,   share: 'Media' });
    assert.deepStrictEqual(n('\\\\192.168.1.10:445\\Media\\'), { host: '192.168.1.10', port: 445, share: 'Media' });
    assert.deepStrictEqual(n('[fe80::1]:445'),           { host: 'fe80::1',      port: 445, share: '' });
});

test('saving a UNC path with an empty Share field takes the share from the path', function () {
    var t = loadSmb({ host: '\\\\nas\\Media', user: 'patrick', pass: 'secret' });
    t.save();
    var c = t.saved();
    assert.strictEqual(c.host, 'nas');
    assert.strictEqual(c.share, 'Media');
    assert.strictEqual(c.port, 445);
    assert.ok(t.toasts.indexOf('SMB server saved') >= 0);
    assert.strictEqual(t.toasts.length, 1, 'no warning when host and share are both present');
});

test('an explicit Share field wins over the path typed after the host', function () {
    var t = loadSmb({ host: 'smb://nas/Media', share: 'Backup' });
    t.save();
    assert.strictEqual(t.saved().share, 'Backup');
});

test('saving logs what was stored, without the password itself', function () {
    var t = loadSmb({ host: '192.168.1.10:4450', share: 'Media', user: 'patrick', pass: 'hunter2' });
    t.save();
    var line = t.lines.filter(function (l) { return /settings saved/.test(l); })[0];
    assert.ok(line, 'a settings-saved line should be logged: ' + JSON.stringify(t.lines));
    assert.ok(/^\[SMB\]/.test(line));
    assert.ok(/host="192\.168\.1\.10" port=4450 share="Media" user="patrick" pass=7 chars/.test(line), line);
    assert.ok(line.indexOf('hunter2') < 0, 'the password must not be logged');
});

test('saving with the share missing says so, in the log and on screen', function () {
    var t = loadSmb({ host: '192.168.1.10' });
    t.save();
    var line = t.lines.filter(function (l) { return /settings saved/.test(l); })[0];
    assert.ok(/host and share are both required/.test(line), line);
    assert.ok(t.toasts.indexOf('Share name is missing') >= 0, JSON.stringify(t.toasts));
});

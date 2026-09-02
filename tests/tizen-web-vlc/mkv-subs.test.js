'use strict';

var assert = require('assert');
var test = require('node:test');
var MkvSubs = require('../../tizen-web-vlc/js/mkv-subs.js');

/* ── Minimal EBML writer ──────────────────────────────────────────────
 *
 * Enough to build the front of a Matroska file: an EBML header, a Segment,
 * and whatever children a test wants inside it.  Sizes always go out as
 * 4-byte vints so the encoder stays trivial. */

var ID = {
    EBML:        0x1A45DFA3,
    SEGMENT:     0x18538067,
    SEEKHEAD:    0x114D9B74,
    ATTACHMENTS: 0x1941A469,
    TRACKS:      0x1654AE6B,
    TRACKENTRY:  0xAE,
    TRACKNUMBER: 0xD7,
    TRACKTYPE:   0x83,
    CODECID:     0x86,
    LANGUAGE:    0x22B59C,
    LANG_IETF:   0x22B59D,
    NAME:        0x536E,
    FLAGFORCED:  0x55AA,
    FLAGHEARIMP: 0x55AB,
    CLUSTER:     0x1F43B675
};

function idBytes(id) {
    var out = [];
    var n = id;
    while (n > 0) { out.unshift(n & 0xff); n = Math.floor(n / 256); }
    return out;
}

// 4-byte vint: marker bit at 0x10, 28 bits of length.
function sizeBytes(len) {
    assert.ok(len < 0x10000000, 'length too big for a 4-byte vint');
    return [0x10 | ((len >>> 24) & 0x0f), (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff];
}

function concat() {
    var parts = Array.prototype.slice.call(arguments);
    var out = [];
    for (var i = 0; i < parts.length; i++) out = out.concat(parts[i]);
    return out;
}

function el(id, payload) {
    return concat(idBytes(id), sizeBytes(payload.length), payload);
}

function str(s) { return Array.prototype.slice.call(Buffer.from(s, 'utf8')); }
function u8(n) { return [n & 0xff]; }
function filler(n) { var a = []; for (var i = 0; i < n; i++) a.push(0); return a; }

/* A subtitle TrackEntry.  `opts` mirrors the elements a real muxer writes. */
function subtitleTrack(number, opts) {
    opts = opts || {};
    var body = concat(
        el(ID.TRACKNUMBER, u8(number)),
        el(ID.TRACKTYPE, u8(17)),                       // 17 = subtitle
        el(ID.CODECID, str(opts.codec || 'S_TEXT/UTF8'))
    );
    if (opts.lang)     body = concat(body, el(ID.LANGUAGE, str(opts.lang)));
    if (opts.langIetf) body = concat(body, el(ID.LANG_IETF, str(opts.langIetf)));
    if (opts.name)     body = concat(body, el(ID.NAME, str(opts.name)));
    if (opts.forced)   body = concat(body, el(ID.FLAGFORCED, u8(1)));
    if (opts.hi)       body = concat(body, el(ID.FLAGHEARIMP, u8(1)));
    return el(ID.TRACKENTRY, body);
}

function videoTrack(number) {
    return el(ID.TRACKENTRY, concat(
        el(ID.TRACKNUMBER, u8(number)),
        el(ID.TRACKTYPE, u8(1)),
        el(ID.CODECID, str('V_MPEGH/ISO/HEVC'))
    ));
}

function audioTrack(number) {
    return el(ID.TRACKENTRY, concat(
        el(ID.TRACKNUMBER, u8(number)),
        el(ID.TRACKTYPE, u8(2)),
        el(ID.CODECID, str('A_EAC3'))
    ));
}

/* Assembles [EBML header][Segment [...children]] and returns the bytes. */
function mkvFile(segmentChildren) {
    return Buffer.from(concat(
        el(ID.EBML, str('matroska')),
        el(ID.SEGMENT, segmentChildren)
    ));
}

/* Reader with the interface mkv-subs.js expects.  `declaredSize` can be far
 * larger than the bytes on hand, which is how a header-only read of a 6 GB
 * movie is simulated: any attempt to read past what we hold would be a read
 * into the movie body, and `reads`/`bytesRead` prove it never happens. */
function stubReader(buf, declaredSize) {
    var r = {
        reads: 0,
        bytesRead: 0,
        maxOffsetRead: 0,
        getSize: function (cb) {
            setImmediate(function () { cb(null, declaredSize || buf.length); });
        },
        readRange: function (off, len, cb) {
            r.reads++;
            // A real reader is bounded by the true file length; at EOF it
            // hands back what exists rather than failing.
            var end = Math.min(off + len, buf.length);
            if (off >= buf.length) { setImmediate(function () { cb(Error('read past EOF')); }); return; }
            r.bytesRead += end - off;
            r.maxOffsetRead = Math.max(r.maxOffsetRead, end);
            var slice = buf.subarray(off, end);
            setImmediate(function () {
                cb(null, slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength));
            });
        },
        close: function () {}
    };
    return r;
}

function listTracks(reader) {
    return new Promise(function (resolve, reject) {
        MkvSubs.listTracks(reader, function (err, tracks) {
            if (err) reject(err); else resolve(tracks);
        });
    });
}

/* ── Tests ───────────────────────────────────────────────────────────── */

test('listTracks enumerates every track, past the point AVPlay truncates', async function () {
    // 1 video + 1 audio + 40 subtitles is the shape that exposed the bug:
    // AVPlay's getTotalTrackInfo() returns 32 entries, so the last ten
    // subtitle tracks never reach the menu.
    var entries = concat(videoTrack(1), audioTrack(2));
    var langs = ['kor', 'chi', 'ara', 'cze', 'dan', 'ger', 'gre', 'eng', 'spa', 'fin',
                 'fil', 'fre', 'heb', 'hrv', 'hun', 'ind', 'ita', 'jpn', 'may', 'nob',
                 'dut', 'pol', 'por', 'rum', 'rus', 'swe', 'tha', 'tur', 'ukr', 'vie',
                 'bul', 'est', 'lav', 'lit', 'slk', 'slv', 'srp', 'ron', 'cat', 'baq'];
    for (var i = 0; i < 40; i++) entries = concat(entries, subtitleTrack(3 + i, { lang: langs[i] }));

    var buf = mkvFile(concat(el(ID.SEEKHEAD, filler(64)), el(ID.TRACKS, entries)));
    var tracks = await listTracks(stubReader(buf));

    assert.strictEqual(tracks.length, 42);
    var subs = tracks.filter(MkvSubs.isSubtitleTrack);
    assert.strictEqual(subs.length, 40);
    assert.strictEqual(subs[0].lang, 'kor');
    // The track AVPlay drops is the one a Vietnamese viewer needs.
    assert.strictEqual(subs[29].lang, 'vie');
    assert.strictEqual(subs[39].lang, 'baq');
});

test('listTracks reads only the header of a huge file', async function () {
    var entries = concat(videoTrack(1), audioTrack(2), subtitleTrack(3, { lang: 'eng' }));
    var buf = mkvFile(el(ID.TRACKS, entries));
    // Claim the 6.0 GB length of the file that prompted this, while holding
    // only the header bytes.
    var reader = stubReader(buf, 6417771952);

    var tracks = await listTracks(reader);
    assert.strictEqual(tracks.length, 3);
    assert.ok(reader.bytesRead < 256 * 1024,
        'expected a header-sized read, got ' + reader.bytesRead + ' bytes');
});

test('listTracks seeks over a big Attachments element instead of reading it', async function () {
    // Cover art in front of Tracks: the scanner must skip the payload, not
    // stream it through the WebView.
    var art = el(ID.ATTACHMENTS, filler(5 * 1024 * 1024));
    var entries = concat(videoTrack(1), subtitleTrack(2, { lang: 'eng' }));
    var buf = mkvFile(concat(art, el(ID.TRACKS, entries)));
    var reader = stubReader(buf);

    var tracks = await listTracks(reader);
    assert.strictEqual(tracks.length, 2);
    assert.ok(reader.bytesRead < 1024 * 1024,
        'attachment payload should be skipped, read ' + reader.bytesRead + ' bytes');
});

test('listTracks prefers the BCP-47 tag only when it adds a region', async function () {
    var entries = concat(
        // Regional variants are the whole point of the BCP-47 element.
        subtitleTrack(1, { lang: 'spa', langIetf: 'es-419', name: 'Latin America' }),
        subtitleTrack(2, { lang: 'spa', langIetf: 'es-ES' }),
        // A bare BCP-47 tag adds nothing over the ISO 639-2 spelling.
        subtitleTrack(3, { lang: 'kor', langIetf: 'ko', name: 'SDH' }),
        // Muxers omit Language for English, leaving only the BCP-47 form.
        subtitleTrack(4, { langIetf: 'en' })
    );
    var tracks = await listTracks(stubReader(mkvFile(el(ID.TRACKS, entries))));

    assert.strictEqual(tracks[0].lang, 'es-419');
    assert.strictEqual(tracks[0].name, 'Latin America');
    assert.strictEqual(tracks[1].lang, 'es-ES');
    assert.strictEqual(tracks[2].lang, 'kor');
    assert.strictEqual(tracks[2].name, 'SDH');
    assert.strictEqual(tracks[3].lang, 'en');
});

test('listTracks reports the flags that tell same-language tracks apart', async function () {
    var entries = concat(
        subtitleTrack(1, { lang: 'eng', name: 'SDH' }),
        subtitleTrack(2, { lang: 'eng', hi: true }),
        subtitleTrack(3, { lang: 'eng', forced: true })
    );
    var tracks = await listTracks(stubReader(mkvFile(el(ID.TRACKS, entries))));

    assert.strictEqual(tracks[0].hearingImpaired, false);
    assert.strictEqual(tracks[0].forced, false);
    assert.strictEqual(tracks[1].hearingImpaired, true);
    assert.strictEqual(tracks[2].forced, true);
});

test('isTextSubtitleTrack accepts text subs and rejects bitmap ones', async function () {
    var entries = concat(
        subtitleTrack(1, { lang: 'eng', codec: 'S_TEXT/UTF8' }),
        subtitleTrack(2, { lang: 'eng', codec: 'S_TEXT/ASS' }),
        subtitleTrack(3, { lang: 'eng', codec: 'S_HDMV/PGS' }),
        subtitleTrack(4, { lang: 'eng', codec: 'S_VOBSUB' })
    );
    var tracks = await listTracks(stubReader(mkvFile(el(ID.TRACKS, entries))));

    // All four are subtitle tracks and all four get listed …
    assert.strictEqual(tracks.filter(MkvSubs.isSubtitleTrack).length, 4);
    // … but only the text ones can be painted by this player.
    assert.deepStrictEqual(tracks.map(MkvSubs.isTextSubtitleTrack),
        [true, true, false, false]);
});

test('listTracks stops at the first cluster when there is no Tracks element', async function () {
    var buf = mkvFile(concat(
        el(ID.SEEKHEAD, filler(32)),
        el(ID.CLUSTER, filler(4096))
    ));
    var reader = stubReader(buf);

    var tracks = await listTracks(reader);
    assert.deepStrictEqual(tracks, []);
    assert.ok(reader.bytesRead < 128 * 1024 + 1);
});

test('listTracks surfaces an unreadable source as an error', async function () {
    await assert.rejects(function () {
        return listTracks({
            getSize: function (cb) { setImmediate(function () { cb(Error('no size')); }); },
            readRange: function (off, len, cb) { cb(Error('unreachable')); },
            close: function () {}
        });
    }, /no size/);
});

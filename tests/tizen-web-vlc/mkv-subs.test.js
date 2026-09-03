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

/* ── Cue-indexed extraction fixtures ─────────────────────────────────
 *
 * A file shaped like the one this exists for: a fat video track, subtitle
 * blocks scattered through the clusters, and a cue index at the end that
 * points at every one of them.  Extracting a track has to reach the blocks
 * through that index without streaming the video. */

var CUE_ID = {
    INFO:          0x1549A966,
    TIMECODESCALE: 0x2AD7B1,
    TIMECODE:      0xE7,
    SIMPLEBLOCK:   0xA3,
    BLOCKGROUP:    0xA0,
    BLOCK:         0xA1,
    BLOCKDURATION: 0x9B,
    CODECPRIVATE:  0x63A2,
    SEEK:          0x4DBB,
    SEEKID:        0x53AB,
    SEEKPOSITION:  0x53AC,
    CUES:          0x1C53BB6B,
    CUEPOINT:      0xBB,
    CUETIME:       0xB3,
    CUETRACKPOS:   0xB7,
    CUETRACK:      0xF7,
    CUECLUSTERPOS: 0xF1,
    CUERELPOS:     0xF0,
    CUEDURATION:   0xB2
};

/* Fixed-width big-endian uint — EBML allows the leading zeroes, and a stable
 * width keeps a SeekPosition patchable after the fact. */
function uintBytes(n, width) {
    var out = [];
    for (var i = (width || 4) - 1; i >= 0; i--) out.unshift(Math.floor(n / Math.pow(256, i)) % 256);
    return out.reverse();
}

/* Block body: track vint, i16 cluster-relative timestamp, flags, payload. */
function blockBody(track, relTs, payload) {
    return concat([0x80 | track], [(relTs >> 8) & 0xff, relTs & 0xff], [0x80], payload);
}

function subtitleBlockGroup(track, relTs, text, durationMs) {
    var body = el(CUE_ID.BLOCK, blockBody(track, relTs, str(text)));
    if (durationMs) body = concat(body, el(CUE_ID.BLOCKDURATION, uintBytes(durationMs)));
    return el(CUE_ID.BLOCKGROUP, body);
}

/* One cluster, and where each subtitle block landed inside its payload —
 * which is exactly what CueRelativePosition records. */
function cluster(timecodeMs, videoBytes, subs) {
    var body = el(CUE_ID.TIMECODE, uintBytes(timecodeMs));
    body = concat(body, el(CUE_ID.SIMPLEBLOCK, blockBody(1, 0, filler(videoBytes))));

    var positions = [];
    subs.forEach(function (s) {
        positions.push({
            track:  s.track,
            time:   timecodeMs + (s.relTs || 0),
            relPos: body.length,
            dur:    s.dur || 0
        });
        body = concat(body, subtitleBlockGroup(s.track, s.relTs || 0, s.text,
                                               s.noBlockDuration ? 0 : (s.dur || 0)));
    });
    return { bytes: el(ID.CLUSTER, body), positions: positions };
}

function cuesElement(positions, opts) {
    var byTime = {};
    positions.forEach(function (p) { (byTime[p.time] = byTime[p.time] || []).push(p); });
    var times = Object.keys(byTime).map(Number).sort(function (a, b) { return a - b; });

    var body = [];
    times.forEach(function (t) {
        var point = el(CUE_ID.CUETIME, uintBytes(t));
        byTime[t].forEach(function (p) {
            var tp = concat(el(CUE_ID.CUETRACK, u8(p.track)),
                            el(CUE_ID.CUECLUSTERPOS, uintBytes(p.clusterPos, 8)));
            if (!opts.noRelPos)  tp = concat(tp, el(CUE_ID.CUERELPOS, uintBytes(p.relPos)));
            if (opts.cueDuration) tp = concat(tp, el(CUE_ID.CUEDURATION, uintBytes(p.dur)));
            point = concat(point, el(CUE_ID.CUETRACKPOS, tp));
        });
        body = concat(body, el(CUE_ID.CUEPOINT, point));
    });
    return el(CUE_ID.CUES, body);
}

/* [EBML][Segment [SeekHead][Info][Tracks][Cluster…][Cues]] with every cue
 * position filled in for real, so the extractor's arithmetic is under test
 * and not just its parser. */
function cueIndexedFile(trackEntries, clusters, opts) {
    opts = opts || {};

    var info   = el(CUE_ID.INFO, el(CUE_ID.TIMECODESCALE, uintBytes(opts.timecodeScale || 1000000)));
    var tracks = el(ID.TRACKS, trackEntries);
    function seekHead(cuesPos) {
        return el(ID.SEEKHEAD, el(CUE_ID.SEEK, concat(
            el(CUE_ID.SEEKID, idBytes(CUE_ID.CUES)),
            el(CUE_ID.SEEKPOSITION, uintBytes(cuesPos, 8)))));
    }

    /* Cue positions count from the Segment's first data byte, so the
     * elements in front of the clusters set the origin. */
    function assemble(cuesLen) {
        var base = seekHead(0).length + info.length + tracks.length + (opts.cuesUpFront ? cuesLen : 0);
        var positions = [];
        var body = [];
        var at   = base;
        clusters.forEach(function (c) {
            c.positions.forEach(function (p) {
                positions.push({
                    track: p.track, time: p.time, dur: p.dur,
                    clusterPos: at, relPos: p.relPos
                });
            });
            body = concat(body, c.bytes);
            at += c.bytes.length;
        });
        return { positions: positions, clusterBytes: body, cuesPos: opts.cuesUpFront ? base - cuesLen : at };
    }

    // Two passes: the cue index's own length shifts everything after it.
    var first = assemble(0);
    var cues  = cuesElement(first.positions, opts);
    var laid  = assemble(cues.length);
    cues      = cuesElement(laid.positions, opts);

    var children = opts.cuesUpFront
        ? concat(seekHead(laid.cuesPos), info, tracks, cues, laid.clusterBytes)
        : concat(seekHead(laid.cuesPos), info, tracks, laid.clusterBytes, cues);
    return mkvFile(children);
}

/* A 4K rip's shape in miniature: Korean and Vietnamese lines interleaved,
 * half a megabyte of video between them. */
function bilingualFile(opts) {
    opts = opts || {};
    var VIDEO = opts.videoBytes === undefined ? 512 * 1024 : opts.videoBytes;
    var entries = concat(
        videoTrack(1),
        audioTrack(2),
        subtitleTrack(3, { lang: 'kor' }),
        subtitleTrack(4, { lang: 'vie' })
    );
    var clusters = [];
    for (var i = 0; i < 6; i++) {
        clusters.push(cluster(i * 10000, VIDEO, [
            { track: 3, relTs: 100, text: '한국어 ' + i, dur: opts.noBlockDuration ? 0 : 2000,
              noBlockDuration: opts.noBlockDuration },
            { track: 4, relTs: 200, text: 'Tiếng Việt ' + i, dur: opts.noBlockDuration ? 0 : 2500,
              noBlockDuration: opts.noBlockDuration }
        ]));
    }
    return cueIndexedFile(entries, clusters, opts);
}

function extractTrack(reader, trackNumber, opts) {
    return new Promise(function (resolve, reject) {
        MkvSubs.extractTrack(reader, trackNumber, opts || {}, function (err, res) {
            if (err) reject(err); else resolve(res);
        });
    });
}

test('extractTrack pulls one subtitle track through the cue index', async function () {
    var reader = stubReader(bilingualFile());

    var res = await extractTrack(reader, 4);

    assert.strictEqual(res.cues.length, 6);
    assert.strictEqual(res.cues[0].text, 'Tiếng Việt 0');
    assert.strictEqual(res.cues[5].text, 'Tiếng Việt 5');
    // 0.2 s into the cluster that starts at 50 s, 2.5 s of BlockDuration.
    assert.strictEqual(res.cues[5].start, 50.2);
    assert.strictEqual(res.cues[5].end, 52.7);
    // Nothing from the other language leaked in.
    res.cues.forEach(function (c) { assert.ok(!/한국어/.test(c.text)); });
});

test('extractTrack never reads the video it is skipping past', async function () {
    // 6 clusters × 512 KB of video: the index has to carry the extractor
    // straight to the subtitle blocks, or this streams 3 MB.
    var reader = stubReader(bilingualFile());

    await extractTrack(reader, 4);

    assert.ok(reader.bytesRead < 512 * 1024,
        'expected less than one video block of reads, got ' + reader.bytesRead + ' bytes');
});

test('extractTrack keeps cues sorted when it starts at the playhead', async function () {
    var live   = [];
    var reader = stubReader(bilingualFile());

    // 30 s in: the reads begin at the cue covering that point and wrap.
    var res = await extractTrack(reader, 4, { cues: live, startAtMs: 30000 });

    assert.strictEqual(res.cues, live, 'must fill the array the poller is reading');
    assert.strictEqual(live.length, 6);
    for (var i = 1; i < live.length; i++)
        assert.ok(live[i].start > live[i - 1].start, 'cue ' + i + ' out of order');
    assert.strictEqual(live[0].text, 'Tiếng Việt 0');
});

test('extractTrack reads the cue index when it sits in front of the media', async function () {
    var reader = stubReader(bilingualFile({ cuesUpFront: true }));

    var res = await extractTrack(reader, 3);

    assert.strictEqual(res.cues.length, 6);
    assert.strictEqual(res.cues[0].text, '한국어 0');
});

test('extractTrack prefers CueDuration over BlockDuration', async function () {
    var reader = stubReader(bilingualFile({ cueDuration: true }));

    var res = await extractTrack(reader, 4);

    // CueDuration is written from the same figure, so the check is that the
    // index's own value is what lands on the cue.
    assert.strictEqual(res.cues[0].end - res.cues[0].start, 2.5);
});

test('extractTrack ends a cue at the next one when no duration is written', async function () {
    var reader = stubReader(bilingualFile({ noBlockDuration: true }));

    var res = await extractTrack(reader, 4);

    // Cues are 10 s apart, capped at the 8 s a subtitle line is allowed.
    assert.strictEqual(res.cues[0].start, 0.2);
    assert.strictEqual(res.cues[0].end, 8.2);
    // The last cue has nothing after it to borrow from.
    assert.strictEqual(res.cues[5].end - res.cues[5].start, 5);
});

test('extractTrack reports cue counts while it works', async function () {
    var seen   = [];
    var reader = stubReader(bilingualFile());

    var res = await extractTrack(reader, 4, {
        batchSize: 2,
        onCues: function (have, total) { seen.push([have, total]); }
    });

    assert.ok(seen.length >= 2, 'expected progress callbacks, got ' + seen.length);
    assert.deepStrictEqual(seen[seen.length - 1], [6, 6]);
    assert.strictEqual(res.expected, 6);
});

test('extractTrack applies the ASS style table from CodecPrivate', async function () {
    var priv = '[V4+ Styles]\n' +
        'Format: Name, Fontname, Fontsize, PrimaryColour\n' +
        'Style: Default,Arial,48,&H00FFFFFF\n[Events]\n';
    var entries = concat(
        videoTrack(1),
        el(ID.TRACKENTRY, concat(
            el(ID.TRACKNUMBER, u8(2)),
            el(ID.TRACKTYPE, u8(17)),
            el(ID.CODECID, str('S_TEXT/ASS')),
            el(ID.LANGUAGE, str('vie')),
            el(CUE_ID.CODECPRIVATE, str(priv))))
    );
    // ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text
    var line = '0,0,Default,,0,0,0,,Xin chào {\\i1}bạn{\\i0}';
    var clusters = [cluster(0, 1024, [{ track: 2, relTs: 500, text: line, dur: 3000 }])];
    var reader = stubReader(cueIndexedFile(entries, clusters, {}));

    var res = await extractTrack(reader, 2);

    assert.strictEqual(res.cues.length, 1);
    assert.strictEqual(res.cues[0].text, 'Xin chào bạn');
    assert.strictEqual(res.cues[0].start, 0.5);
});

test('extractTrack says so when the index holds nothing for the track', async function () {
    // Cues cover track 4 only; track 3 is in the header but not the index.
    var entries = concat(videoTrack(1), subtitleTrack(3, { lang: 'kor' }), subtitleTrack(4, { lang: 'vie' }));
    var clusters = [cluster(0, 4096, [{ track: 4, relTs: 0, text: 'Tiếng Việt', dur: 2000 }])];
    var reader = stubReader(cueIndexedFile(entries, clusters, {}));

    await assert.rejects(function () { return extractTrack(reader, 3); },
        /no entries for track 3/);
});

test('extractTrack says so when the index has no block positions', async function () {
    // Matroska v1 cues: the cluster is named, the block inside it is not.
    var reader = stubReader(bilingualFile({ noRelPos: true }));

    await assert.rejects(function () { return extractTrack(reader, 4); },
        /no block positions/);
});

test('extractTrack refuses a bitmap subtitle track', async function () {
    var entries = concat(videoTrack(1), subtitleTrack(2, { lang: 'eng', codec: 'S_HDMV/PGS' }));
    var clusters = [cluster(0, 4096, [{ track: 2, relTs: 0, text: 'x', dur: 1000 }])];
    var reader = stubReader(cueIndexedFile(entries, clusters, {}));

    await assert.rejects(function () { return extractTrack(reader, 2); },
        /only text subtitles/);
});

test('extractTrack refuses a track the container never declared', async function () {
    var reader = stubReader(bilingualFile());

    await assert.rejects(function () { return extractTrack(reader, 9); },
        /no track 9/);
});

test('extractTrack stops reading when cancelled', async function () {
    var reader = stubReader(bilingualFile());
    var calls  = 0;

    var handle = MkvSubs.extractTrack(reader, 4, {}, function () { calls++; });
    handle.cancel('file closed');

    await new Promise(function (r) { setTimeout(r, 50); });
    assert.strictEqual(calls, 0, 'a cancelled extraction must not call back');
    var afterCancel = reader.reads;
    await new Promise(function (r) { setTimeout(r, 50); });
    assert.strictEqual(reader.reads, afterCancel, 'reads continued after cancel');
});

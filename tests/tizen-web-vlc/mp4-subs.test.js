'use strict';

var assert = require('assert');
var test = require('node:test');
var Mp4Subs = require('../../tizen-web-vlc/js/mp4-subs.js');

function bytes() {
    var parts = Array.prototype.slice.call(arguments);
    var total = 0;
    var offset = 0;

    for (var i = 0; i < parts.length; i++) total += parts[i].length;

    var out = new Uint8Array(total);
    for (var j = 0; j < parts.length; j++) {
        out.set(parts[j], offset);
        offset += parts[j].length;
    }

    return out;
}

function ascii(value) {
    var out = new Uint8Array(value.length);
    for (var i = 0; i < value.length; i++) out[i] = value.charCodeAt(i) & 255;
    return out;
}

function u32(value) {
    return new Uint8Array([
        (value >>> 24) & 255,
        (value >>> 16) & 255,
        (value >>> 8) & 255,
        value & 255
    ]);
}

function u16(value) {
    return new Uint8Array([(value >>> 8) & 255, value & 255]);
}

function box(type, body) {
    return bytes(u32(body.length + 8), ascii(type), body);
}

function fullBox(type, body) {
    return box(type, bytes(new Uint8Array([0, 0, 0, 0]), body));
}

function packedLang(lang) {
    return ((lang.charCodeAt(0) - 0x60) << 10) |
           ((lang.charCodeAt(1) - 0x60) << 5) |
           (lang.charCodeAt(2) - 0x60);
}

function textSample(value) {
    var encoded = new TextEncoder().encode(value);
    return bytes(u16(encoded.length), encoded);
}

function makeTrack(sampleOffsets, sampleSizes) {
    var tkhd = fullBox('tkhd', bytes(
        u32(0),
        u32(0),
        u32(7)
    ));
    var mdhd = fullBox('mdhd', bytes(
        u32(0),
        u32(0),
        u32(1000),
        u32(4000),
        u16(packedLang('eng')),
        u16(0)
    ));
    var hdlr = fullBox('hdlr', bytes(
        u32(0),
        ascii('text'),
        u32(0),
        u32(0),
        u32(0),
        ascii('SubtitleHandler\0')
    ));
    var stsd = fullBox('stsd', bytes(
        u32(1),
        u32(8),
        ascii('tx3g')
    ));
    var stts = fullBox('stts', bytes(
        u32(2),
        u32(1), u32(1500),
        u32(1), u32(2500)
    ));
    var stsc = fullBox('stsc', bytes(
        u32(1),
        u32(1), u32(1), u32(1)
    ));
    var stsz = fullBox('stsz', bytes(
        u32(0),
        u32(sampleSizes.length),
        u32(sampleSizes[0]),
        u32(sampleSizes[1])
    ));
    var stco = fullBox('stco', bytes(
        u32(sampleOffsets.length),
        u32(sampleOffsets[0]),
        u32(sampleOffsets[1])
    ));
    var stbl = box('stbl', bytes(stsd, stts, stsc, stsz, stco));
    var minf = box('minf', stbl);
    var mdia = box('mdia', bytes(mdhd, hdlr, minf));

    return box('trak', bytes(tkhd, mdia));
}

function fixture() {
    var ftyp = box('ftyp', bytes(ascii('isom'), u32(0), ascii('isom')));
    var samples = [textSample('Hello from a huge MP4'), textSample('Second cue')];
    var filler = new Uint8Array(12);
    var firstSampleOffset = ftyp.length + 8 + filler.length;
    var secondSampleOffset = firstSampleOffset + samples[0].length;
    var mdat = box('mdat', bytes(filler, samples[0], samples[1]));
    var moov = box('moov', makeTrack(
        [firstSampleOffset, secondSampleOffset],
        [samples[0].length, samples[1].length]
    ));

    return bytes(ftyp, mdat, moov);
}

function fixtureWithBadTailBoxBeforeMoov() {
    var data = fixture();
    var ftypSize = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0);
    var mdatSize = new DataView(data.buffer, data.byteOffset + ftypSize, data.byteLength - ftypSize).getUint32(0);
    var moovOffset = ftypSize + mdatSize;
    var badTailBox = bytes(u32(0x7fffffff), ascii('free'), new Uint8Array([1, 2, 3, 4]));

    return bytes(
        data.subarray(0, moovOffset),
        badTailBox,
        data.subarray(moovOffset)
    );
}

function fixtureWithBadTailBoxAndTrailingJunk() {
    return bytes(
        fixtureWithBadTailBoxBeforeMoov(),
        new Uint8Array(96 * 1024)
    );
}

function MockRangeReader(data, virtualSize, internalChunk, delay) {
    this.data = data;
    this.size = virtualSize || data.length;
    this.internalChunk = internalChunk || 3;
    this.delay = delay || 0;
    this.closed = false;
    this.maxRequested = 0;
    this.requests = [];
    this.failRanges = [];
}

MockRangeReader.prototype.getSize = function (cb) {
    var self = this;
    setTimeout(function () {
        cb(self.closed ? Error('closed') : null, self.size);
    }, this.delay);
};

MockRangeReader.prototype.readRange = function (offset, length, cb) {
    var self = this;
    this.maxRequested = Math.max(this.maxRequested, length);
    this.requests.push({ offset: offset, length: length });

    setTimeout(function () {
        if (self.closed) {
            cb(Error('closed'));
            return;
        }
        for (var i = 0; i < self.failRanges.length; i++) {
            var range = self.failRanges[i];
            if (offset < range.end && offset + length > range.start) {
                cb(Error('configured read failure'));
                return;
            }
        }
        if (offset + length > self.data.length) {
            cb(Error('fixture read out of range'));
            return;
        }

        var out = new Uint8Array(length);
        var written = 0;
        while (written < length) {
            var take = Math.min(self.internalChunk, length - written);
            out.set(self.data.subarray(offset + written, offset + written + take), written);
            written += take;
        }

        cb(null, out.buffer);
    }, this.delay);
};

MockRangeReader.prototype.close = function () {
    this.closed = true;
};

function incremental(reader, options) {
    return new Promise(function (resolve, reject) {
        var eventOrder = [];
        var extractOptions = options || {};

        extractOptions.chunkSize = extractOptions.chunkSize || 64 * 1024;
        extractOptions.onTracks = function (tracks) {
            eventOrder.push('tracks');
            assert.strictEqual(tracks[0].cues.length, 0);
        };
        extractOptions.onCues = function () {
            eventOrder.push('cues');
        };
        extractOptions.onComplete = function (tracks) {
            resolve({ tracks: tracks, eventOrder: eventOrder });
        };
        extractOptions.onError = reject;

        Mp4Subs.extractIncremental(reader, extractOptions);
    });
}

test('extracts a virtual 22 GB MP4 with bounded reads', async function () {
    var data = fixture();
    var twentyTwoGbReader = new MockRangeReader(data, 22 * 1024 * 1024 * 1024, 3);
    var result = await incremental(twentyTwoGbReader);
    var tracks = result.tracks;

    assert.strictEqual(tracks.length, 1, 'one embedded MP4 text track');
    assert.strictEqual(tracks[0].id, 7);
    assert.strictEqual(tracks[0].lang, 'eng');
    assert.strictEqual(tracks[0].codec, 'tx3g');
    assert.strictEqual(tracks[0].cues.length, 2);
    assert.strictEqual(tracks[0].cues[0].start, 0);
    assert.strictEqual(tracks[0].cues[0].end, 1.5);
    assert.strictEqual(tracks[0].cues[0].text, 'Hello from a huge MP4');
    assert.strictEqual(tracks[0].cues[1].start, 1.5);
    assert.strictEqual(tracks[0].cues[1].end, 4);
    assert.strictEqual(tracks[0].cues[1].text, 'Second cue');
    assert.ok(
        result.eventOrder.indexOf('tracks') < result.eventOrder.indexOf('cues'),
        'metadata is published before sample extraction'
    );
    assert.ok(twentyTwoGbReader.maxRequested <= 64 * 1024, 'reads stay bounded independent of virtual 22 GB size');
    assert.ok(twentyTwoGbReader.closed, 'reader closed on success');
});

test('keeps the legacy full-buffer parser working', function () {
    var data = fixture();
    var fullBufferTracks = Mp4Subs._extractCueLists(data.buffer);
    assert.strictEqual(fullBufferTracks.length, 1, 'legacy full-buffer parser regression');
    assert.strictEqual(fullBufferTracks[0].cues[1].text, 'Second cue');
});

test('finds moov with tail fallback after a malformed top-level box', async function () {
    var badTailData = fixtureWithBadTailBoxBeforeMoov();
    var fallbackResult = await incremental(new MockRangeReader(badTailData));
    assert.strictEqual(fallbackResult.tracks.length, 1, 'tail fallback finds moov after a malformed box');
    assert.strictEqual(fallbackResult.tracks[0].cues[0].text, 'Hello from a huge MP4');
});

test('tail fallback searches beyond the final chunk', async function () {
    var multiChunkTailData = fixtureWithBadTailBoxAndTrailingJunk();
    var multiChunkResult = await incremental(new MockRangeReader(multiChunkTailData), {
        chunkSize: 64 * 1024,
        maxTailSearchBytes: 256 * 1024,
        tailSearchChunkBytes: 32 * 1024
    });
    assert.strictEqual(multiChunkResult.tracks.length, 1, 'tail fallback searches beyond the final chunk');
    assert.strictEqual(multiChunkResult.tracks[0].cues[1].text, 'Second cue');
});

test('cancels in-flight extraction without publishing callbacks', async function () {
    var data = fixture();
    var callbackCount = 0;
    var delayedReader = new MockRangeReader(data, data.length, 3, 5);
    var job = Mp4Subs.extractIncremental(delayedReader, {
        onTracks: function () { callbackCount++; },
        onComplete: function () { callbackCount++; },
        onError: function () { callbackCount++; }
    });

    job.cancel('test');
    await new Promise(function (resolve) { setTimeout(resolve, 25); });

    assert.strictEqual(callbackCount, 0, 'cancelled scans cannot publish callbacks');
    assert.ok(delayedReader.closed, 'reader closed on cancellation');
});

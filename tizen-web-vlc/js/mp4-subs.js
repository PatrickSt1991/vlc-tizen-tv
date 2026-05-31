/* MP4 embedded-subtitle extractor.
 *
 * Why this exists: Tizen 5.0's AVPlay won't deliver per-cue events for
 * embedded TEXT/SUBTITLE tracks selected via setSelectTrack — it fires
 * onsubtitlechange exactly once when the track is selected.  But it DOES
 * deliver per-cue events when subtitles come from an external file loaded
 * via setExternalSubtitlePath.  So: we parse the MP4 ourselves, extract
 * each text-subtitle track to its own SRT in wgt-private-tmp, and treat
 * those generated SRTs as if they were external siblings.
 *
 * Codecs supported: tx3g (3GPP timed text) and mov_text (MP4 text).
 * Sample format for both: u16be length + UTF-8 text.  Modifier boxes
 * after the text (style, colour, etc.) are skipped.
 */

var Mp4Subs = (function () {

    function fmtSrtTime(seconds) {
        var ms = Math.floor((seconds - Math.floor(seconds)) * 1000);
        var s = Math.floor(seconds);
        var h = Math.floor(s / 3600); s -= h * 3600;
        var m = Math.floor(s / 60);   s -= m * 60;
        var p2 = function (n) { return n < 10 ? '0' + n : '' + n; };
        var p3 = function (n) { return n < 10 ? '00' + n : n < 100 ? '0' + n : '' + n; };
        return p2(h) + ':' + p2(m) + ':' + p2(s) + ',' + p3(ms);
    }

    /* Unpack ISO 639-2/T language tag from the packed 15-bit form in mdhd. */
    function unpackLang(packed) {
        var a = ((packed >> 10) & 0x1F) + 0x60;
        var b = ((packed >>  5) & 0x1F) + 0x60;
        var c = ( packed        & 0x1F) + 0x60;
        var s = String.fromCharCode(a, b, c);
        return /^[a-z]{3}$/.test(s) ? s : '';
    }

    /* Walk ISO-BMFF boxes recursively.  Visitor is called with
     * (type, bodyOffset, bodyEnd, parentType).  Container boxes are
     * automatically descended. */
    var CONTAINER_BOXES = { moov:1, trak:1, mdia:1, minf:1, stbl:1, edts:1, dinf:1 };
    function walk(view, off, end, visitor, parentType) {
        while (off < end - 8) {
            var size = view.getUint32(off);
            var type = String.fromCharCode(
                view.getUint8(off+4), view.getUint8(off+5),
                view.getUint8(off+6), view.getUint8(off+7));
            var headSize = 8;
            if (size === 1) {
                // 64-bit size at off+8
                var hi = view.getUint32(off+8);
                var lo = view.getUint32(off+12);
                size = hi * 0x100000000 + lo;
                headSize = 16;
            } else if (size === 0) {
                size = end - off;
            }
            var bodyOff = off + headSize;
            var bodyEnd = off + size;
            if (bodyEnd > end || size < 8) break;

            visitor(type, bodyOff, bodyEnd, parentType);

            if (CONTAINER_BOXES[type]) walk(view, bodyOff, bodyEnd, visitor, type);
            off += size;
        }
    }

    /* Parse a single tkhd, mdhd, hdlr, stsd, stts, stsz, stco, co64, stsc
     * into structured data on the given track object. */
    function parseTkhd(view, off /*, end*/) {
        var version = view.getUint8(off);
        return version === 0
            ? view.getUint32(off + 12)
            : view.getUint32(off + 20);
    }
    function parseMdhd(view, off) {
        var version = view.getUint8(off);
        var tsOff   = version === 0 ? off + 12 : off + 20;
        var langOff = version === 0 ? off + 20 : off + 28;
        return {
            timescale: view.getUint32(tsOff),
            lang:      unpackLang(view.getUint16(langOff))
        };
    }
    function parseHdlr(view, off) {
        return String.fromCharCode(
            view.getUint8(off+8),  view.getUint8(off+9),
            view.getUint8(off+10), view.getUint8(off+11));
    }
    function parseStsd(view, off) {
        // version(1)+flags(3)+entry_count(4) then array of SampleEntry
        var entryCount = view.getUint32(off + 4);
        if (entryCount < 1) return '';
        // First SampleEntry starts at off+8: u32 size, u32 codec
        return String.fromCharCode(
            view.getUint8(off+12), view.getUint8(off+13),
            view.getUint8(off+14), view.getUint8(off+15));
    }
    function parseStts(view, off) {
        var n = view.getUint32(off + 4);
        var out = [];
        var p = off + 8;
        for (var i = 0; i < n; i++) {
            out.push({ count: view.getUint32(p), delta: view.getUint32(p + 4) });
            p += 8;
        }
        return out;
    }
    function parseStsz(view, off) {
        var sampleSize = view.getUint32(off + 4);
        var sampleCount = view.getUint32(off + 8);
        var sizes = new Array(sampleCount);
        if (sampleSize > 0) {
            for (var i = 0; i < sampleCount; i++) sizes[i] = sampleSize;
        } else {
            var p = off + 12;
            for (var j = 0; j < sampleCount; j++) {
                sizes[j] = view.getUint32(p);
                p += 4;
            }
        }
        return sizes;
    }
    function parseStco(view, off, sizeIs64) {
        var n = view.getUint32(off + 4);
        var out = new Array(n);
        var p = off + 8;
        for (var i = 0; i < n; i++) {
            if (sizeIs64) {
                var hi = view.getUint32(p);
                var lo = view.getUint32(p + 4);
                out[i] = hi * 0x100000000 + lo;
                p += 8;
            } else {
                out[i] = view.getUint32(p);
                p += 4;
            }
        }
        return out;
    }
    function parseStsc(view, off) {
        var n = view.getUint32(off + 4);
        var out = new Array(n);
        var p = off + 8;
        for (var i = 0; i < n; i++) {
            out[i] = {
                firstChunk:      view.getUint32(p),
                samplesPerChunk: view.getUint32(p + 4),
                sampleDescIndex: view.getUint32(p + 8)
            };
            p += 12;
        }
        return out;
    }

    /* From stsc + stco, compute the file offset of every sample. */
    function computeSampleOffsets(stsc, stco, sampleCount, sampleSizes) {
        var offsets = new Array(sampleCount);
        var sampleIdx = 0;
        for (var c = 0; c < stco.length; c++) {
            // Find the stsc entry that applies to chunk (c+1)
            var samplesInChunk = stsc[0].samplesPerChunk;
            for (var s = stsc.length - 1; s >= 0; s--) {
                if (c + 1 >= stsc[s].firstChunk) {
                    samplesInChunk = stsc[s].samplesPerChunk;
                    break;
                }
            }
            var chunkOff = stco[c];
            for (var k = 0; k < samplesInChunk; k++) {
                if (sampleIdx >= sampleCount) break;
                offsets[sampleIdx] = chunkOff;
                chunkOff += sampleSizes[sampleIdx];
                sampleIdx++;
            }
            if (sampleIdx >= sampleCount) break;
        }
        return offsets;
    }

    /* Build a flat list of {startTicks, endTicks} for every sample from stts. */
    function expandStts(stts, sampleCount) {
        var times = new Array(sampleCount);
        var idx = 0;
        var t = 0;
        for (var i = 0; i < stts.length && idx < sampleCount; i++) {
            for (var k = 0; k < stts[i].count && idx < sampleCount; k++) {
                times[idx] = { start: t, end: t + stts[i].delta };
                t += stts[i].delta;
                idx++;
            }
        }
        // Fill remaining if stts is short (shouldn't happen in valid files)
        while (idx < sampleCount) { times[idx] = { start: t, end: t }; idx++; }
        return times;
    }

    /* Decode a tx3g/mov_text sample: 16-bit big-endian length + UTF-8 bytes. */
    function decodeTextSample(buf, off, len) {
        if (len < 2) return '';
        var view = new DataView(buf, off, len);
        var textLen = view.getUint16(0);
        if (textLen === 0 || textLen > len - 2) return '';
        var bytes = new Uint8Array(buf, off + 2, textLen);
        try {
            return new TextDecoder('utf-8').decode(bytes);
        } catch (e) {
            // Fallback: naive UTF-8 → char-by-char (handles ASCII + some Latin)
            var s = '';
            for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
            return s;
        }
    }

    /* Top-level: parse a whole MP4 buffer and return per-track cue lists. */
    function parseMp4(buf) {
        var view = new DataView(buf);
        var tracks = [];
        var cur = null;

        walk(view, 0, buf.byteLength, function (type, off, end, parent) {
            if (type === 'trak') {
                if (cur) tracks.push(cur);
                cur = { co64: false, sampleSizes: [], chunkOffsets: [], stsc: [], stts: [] };
                return;
            }
            if (!cur) return;
            switch (type) {
                case 'tkhd': cur.id   = parseTkhd(view, off); break;
                case 'mdhd':
                    var m = parseMdhd(view, off);
                    cur.timescale = m.timescale;
                    cur.lang      = m.lang;
                    break;
                case 'hdlr': cur.handler = parseHdlr(view, off); break;
                case 'stsd': cur.codec   = parseStsd(view, off); break;
                case 'stts': cur.stts    = parseStts(view, off); break;
                case 'stsz': cur.sampleSizes = parseStsz(view, off); break;
                case 'stco': cur.chunkOffsets = parseStco(view, off, false); break;
                case 'co64': cur.chunkOffsets = parseStco(view, off, true);  cur.co64 = true; break;
                case 'stsc': cur.stsc    = parseStsc(view, off); break;
            }
        }, null);
        if (cur) tracks.push(cur);
        return tracks;
    }

    /* Filter tracks → just the text subtitles we can decode + extract their cues. */
    function extractCueLists(buf) {
        var tracks = parseMp4(buf);
        var out = [];
        for (var i = 0; i < tracks.length; i++) {
            var t = tracks[i];
            // Subtitle handlers: 'subt' (ISO BMFF), 'sbtl' (mov), 'text' (legacy)
            var isSub = (t.handler === 'subt' || t.handler === 'sbtl' || t.handler === 'text');
            if (!isSub) continue;
            var codecOK = (t.codec === 'tx3g' || t.codec === 'text' || t.codec === 'mov_');
            if (!codecOK) continue;
            if (!t.timescale || !t.sampleSizes.length) continue;

            var offsets = computeSampleOffsets(t.stsc, t.chunkOffsets,
                                               t.sampleSizes.length, t.sampleSizes);
            var times   = expandStts(t.stts, t.sampleSizes.length);
            var cues    = [];
            for (var s = 0; s < t.sampleSizes.length; s++) {
                var size = t.sampleSizes[s];
                if (!size) continue;
                var text = decodeTextSample(buf, offsets[s], size).trim();
                if (!text) continue;
                cues.push({
                    start: times[s].start / t.timescale,    // seconds
                    end:   times[s].end   / t.timescale,
                    text:  text
                });
            }
            if (cues.length) out.push({
                id:   t.id,
                lang: t.lang || '',
                cues: cues
            });
        }
        return out;
    }

    function cuesToSrt(cues) {
        var lines = [];
        for (var i = 0; i < cues.length; i++) {
            lines.push(String(i + 1));
            lines.push(fmtSrtTime(cues[i].start) + ' --> ' + fmtSrtTime(cues[i].end));
            lines.push(cues[i].text);
            lines.push('');
        }
        return lines.join('\n');
    }

    /* Public entry point.
     *
     *   file: a Tizen File object (with .toURI()) OR a string file URI
     *   cb:   function(err, [{id, lang, cues, srt}])
     *
     * Reads the whole file as ArrayBuffer via XHR.  For large files we could
     * later switch to Range-request partial reads, but for ≤2 GB MP4s this
     * is simple and correct. */
    /* Hard cap on whole-file loading.  Anything bigger gets skipped — we'd
     * blow the TV's RAM trying to ArrayBuffer a 4 GB movie.  Proper fix is
     * Range-based partial reads (moov + per-sample mdat ranges) but that
     * needs to be validated against Tizen Chromium's file:// behaviour
     * first.  TODO: implement partial reads. */
    var MAX_FULL_LOAD_BYTES = 200 * 1024 * 1024;       // 200 MB

    function extract(file, cb) {
        var uri = (typeof file === 'string') ? file
                : (typeof file.toURI === 'function') ? file.toURI()
                : '';
        if (!uri) { cb(new Error('no usable URI on file')); return; }
        var xhr = new XMLHttpRequest();
        try { xhr.open('GET', uri, true); } catch (e) { cb(e); return; }
        xhr.responseType = 'arraybuffer';
        var aborted = false;
        xhr.onprogress = function (e) {
            if (aborted) return;
            if (e && e.lengthComputable && e.total > MAX_FULL_LOAD_BYTES) {
                aborted = true;
                try { xhr.abort(); } catch (_) {}
                cb(new Error('file too large for in-memory extraction: ' +
                             Math.round(e.total / 1048576) + ' MB > ' +
                             Math.round(MAX_FULL_LOAD_BYTES / 1048576) + ' MB'));
            }
        };
        xhr.onload = function () {
            if (aborted) return;
            if (!xhr.response) { cb(new Error('empty XHR response')); return; }
            if (xhr.response.byteLength > MAX_FULL_LOAD_BYTES) {
                cb(new Error('file too large: ' + xhr.response.byteLength + ' bytes'));
                return;
            }
            try {
                var subs = extractCueLists(xhr.response);
                for (var i = 0; i < subs.length; i++) subs[i].srt = cuesToSrt(subs[i].cues);
                cb(null, subs);
            } catch (e) { cb(e); }
        };
        xhr.onerror = function () {
            if (!aborted) cb(new Error('XHR failed loading ' + uri));
        };
        xhr.send();
    }

    /* Write an SRT string into wgt-private-tmp and call cb with a record:
     *   file:     Tizen File object (Browser.readSubtitleText needs this for
     *             the JS time-poller fallback path)
     *   uri:      file:// URI
     *   fullPath: REAL filesystem path AVPlay's setExternalSubtitlePath wants.
     *             The virtual 'wgt-private-tmp/…' that File.fullPath gives us
     *             is rejected with PLAYER_ERROR_INVALID_PARAMETER — only the
     *             real /opt/usr/apps/<pkg>/tmp/… path works.  Derive it by
     *             stripping 'file://' from File.toURI(). */
    function writeSrtToTmp(srt, name, cb) {
        try {
            tizen.filesystem.resolve('wgt-private-tmp', function (dir) {
                var safe = String(name).replace(/[^A-Za-z0-9_.-]+/g, '_');
                // Random suffix so old extractions don't collide.
                var fname = 'embed_' + safe + '_' + Math.floor(Math.random() * 1e9) + '.srt';
                try {
                    if (dir.fileExists && dir.fileExists(fname)) dir.deleteFile(dir.fullPath + '/' + fname);
                } catch (e) {}
                var f;
                try { f = dir.createFile(fname); }
                catch (e) { cb(e); return; }
                f.openStream('w', function (stream) {
                    try {
                        stream.write(srt);
                        stream.close();
                        var uri      = (typeof f.toURI === 'function') ? f.toURI() : '';
                        var realPath = '';
                        if (uri.indexOf('file://') === 0) {
                            realPath = uri.slice(7);
                            try { realPath = decodeURIComponent(realPath); } catch (e) {}
                        }
                        cb(null, {
                            file:     f,
                            uri:      uri || ('file://' + (f.fullPath || '')),
                            fullPath: realPath || f.fullPath
                        });
                    } catch (e) { cb(e); }
                }, function (e) { cb(e); }, 'UTF-8');
            }, function (e) { cb(e); }, 'rw');
        } catch (e) { cb(e); }
    }

    return {
        extract:       extract,
        cuesToSrt:     cuesToSrt,
        writeSrtToTmp: writeSrtToTmp
    };
})();

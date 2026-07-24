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
 * Codecs supported: tx3g (3GPP timed text) and mov_text / text tracks.
 * Sample format for both: u16be length + UTF-8 text.  Modifier boxes
 * after the text (style, colour, etc.) are skipped.
 *
 * Large-file flow:
 *   1. Open a generic range reader for the local file.
 *   2. Walk top-level MP4 boxes by declared size until moov is found.
 *   3. Parse moov track/sample tables to locate supported text tracks.
 *   4. Range-read only subtitle samples and append cues to live tracks.
 * This keeps memory bounded by metadata/sample size, not movie size.
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
     * Reads the whole file as ArrayBuffer via XHR. Kept for compatibility
     * with small-file callers; Player uses extractIncremental() when it can
     * pass a local Tizen File object. */
    /* Hard cap on whole-file loading. Anything bigger gets skipped here;
     * large local files should use extractIncremental() instead. */
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

    /* ── Incremental local-file extractor ────────────────────────────── */

    var DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;
    var DEFAULT_INTERNAL_READ_BYTES = 256 * 1024;
    var DEFAULT_MAX_MOOV_BYTES = 64 * 1024 * 1024;
    var DEFAULT_MAX_SAMPLE_BYTES = 2 * 1024 * 1024;
    var DEFAULT_MAX_TAIL_SEARCH_BYTES = 512 * 1024 * 1024;
    var DEFAULT_TAIL_SEARCH_CHUNK_BYTES = 64 * 1024;
    var DEFAULT_XHR_RANGE_TIMEOUT_MS = 30000;
    var MAX_CHUNK_BYTES = 16 * 1024 * 1024;
    var MIN_CHUNK_BYTES = 64 * 1024;
    var MIN_INTERNAL_READ_BYTES = 16 * 1024;
    var MP4_HEADER_READ_BYTES = 16;
    var SAFE_TIZEN_SEEK_STEP_BYTES = 1024 * 1024 * 1024;
    var TAIL_SEARCH_OVERLAP_BYTES = 32;

    function later(fn) {
        setTimeout(fn, 0);
    }

    function log(message) {
        if (typeof Debug !== 'undefined') Debug.player('MP4 sub scan: ' + message);
    }

    function warn(message) {
        if (typeof Debug !== 'undefined') Debug.warn('MP4 sub scan: ' + message);
    }

    function filePathOf(file) {
        if (file && file.fullPath) return file.fullPath;

        var path = String(file || '');
        if (path.indexOf('file://') === 0) path = path.slice(7);

        try { path = decodeURIComponent(path); } catch (e) {}
        return path;
    }

    function isValidRange(offset, length, size) {
        return Number.isSafeInteger(offset) &&
               Number.isSafeInteger(length) &&
               offset >= 0 &&
               length >= 0 &&
               offset <= size;
    }

    // Wrap Tizen's newer openFile()/FileHandle API in the generic range-reader
    // interface used by the incremental MP4 parser.
    function makeModernReader(handle, size, internalReadSize) {
        var closed = false;
        var position = 0;
        var positionKnown = false;

        function seekTo(offset) {
            if (!Number.isSafeInteger(offset) || offset < 0 || offset > size) {
                throw Error('invalid seek offset');
            }

            if (positionKnown && offset === position) return;

            var canSeekForwardFromHere = positionKnown &&
                                         offset > position &&
                                         offset - position <= SAFE_TIZEN_SEEK_STEP_BYTES;
            if (!canSeekForwardFromHere) {
                if (offset <= SAFE_TIZEN_SEEK_STEP_BYTES) {
                    handle.seek(offset, 'BEGIN');
                    position = offset;
                    positionKnown = true;
                    return;
                }

                handle.seek(0, 'BEGIN');
                position = 0;
                positionKnown = true;
            }

            var remaining = offset - position;
            while (remaining > 0) {
                var step = Math.min(remaining, SAFE_TIZEN_SEEK_STEP_BYTES);
                handle.seek(step, 'CURRENT');
                position += step;
                remaining -= step;
            }
        }

        return {
            implementation: 'Tizen FileHandle (chunked seek)',

            getSize: function (cb) {
                later(function () { cb(null, size); });
            },

            readRange: function (offset, length, cb) {
                if (closed || !isValidRange(offset, length, size)) {
                    later(function () { cb(Error('invalid/closed range')); });
                    return;
                }

                length = Math.min(length, size - offset);
                var out = new Uint8Array(length);
                var written = 0;

                try {
                    seekTo(offset);
                } catch (e) {
                    positionKnown = false;
                    cb(e);
                    return;
                }

                function readNextPart() {
                    if (closed) {
                        cb(Error('reader closed'));
                        return;
                    }
                    if (written === length) {
                        cb(null, out.buffer);
                        return;
                    }

                    var take = Math.min(internalReadSize, length - written);

                    function appendChunk(chunk) {
                        chunk = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk || []);
                        if (!chunk.length) {
                            cb(Error('unexpected EOF'));
                            return;
                        }

                        var copied = Math.min(chunk.length, take);
                        out.set(chunk.subarray(0, copied), written);
                        written += copied;
                        position += copied;
                        positionKnown = true;
                        later(readNextPart);
                    }

                    try {
                        if (handle.readDataNonBlocking) {
                            handle.readDataNonBlocking(appendChunk, cb, take);
                        } else {
                            appendChunk(handle.readData(take));
                        }
                    } catch (e) {
                        cb(e);
                    }
                }

                later(readNextPart);
            },

            close: function () {
                if (closed) return;
                closed = true;
                try { handle.close(); } catch (e) {}
            }
        };
    }

    // Prefer browser byte-range requests for file:// URIs when available;
    // they can read large-file offsets without loading the whole movie.
    function makeXhrRangeReader(uri, size, timeoutMs) {
        return {
            implementation: 'XHR Range',

            getSize: function (cb) {
                later(function () { cb(null, size); });
            },

            readRange: function (offset, length, cb) {
                if (!isValidRange(offset, length, size)) {
                    later(function () { cb(Error('invalid range')); });
                    return;
                }
                if (!length) {
                    later(function () { cb(null, new ArrayBuffer(0)); });
                    return;
                }

                length = Math.min(length, size - offset);

                var xhr = new XMLHttpRequest();
                var aborted = false;
                var maxAcceptedLoad = Math.max(length + 65536, 1024 * 1024);

                function fail(err) {
                    if (aborted) return;
                    aborted = true;
                    try { xhr.abort(); } catch (e) {}
                    cb(err instanceof Error ? err : Error(String(err)));
                }

                try {
                    xhr.open('GET', uri, true);
                    xhr.timeout = timeoutMs;
                    xhr.responseType = 'arraybuffer';
                    xhr.setRequestHeader('Range', 'bytes=' + offset + '-' + (offset + length - 1));
                } catch (e) {
                    fail(e);
                    return;
                }

                xhr.onprogress = function (e) {
                    if (aborted) return;

                    if (e && e.lengthComputable && e.total > maxAcceptedLoad) {
                        fail(Error('XHR range ignored; response total=' + e.total +
                                   ' requested=' + length));
                    } else if (e && e.loaded > maxAcceptedLoad) {
                        fail(Error('XHR range exceeded bounded read; loaded=' + e.loaded +
                                   ' requested=' + length));
                    }
                };
                xhr.onload = function () {
                    if (aborted) return;

                    var buffer = xhr.response;
                    if (!buffer) {
                        fail(Error('empty XHR range response'));
                        return;
                    }

                    if (buffer.byteLength !== length) {
                        fail(Error('XHR range returned ' + buffer.byteLength +
                                   ' bytes for requested ' + length));
                        return;
                    }

                    cb(null, buffer);
                };
                xhr.onerror = function () {
                    fail(Error('XHR range failed'));
                };
                xhr.ontimeout = function () {
                    fail(Error('XHR range timed out'));
                };
                xhr.send();
            },

            close: function () {}
        };
    }

    // Fallback for older Tizen FileStream objects. It is limited to 32-bit
    // offsets, so it can only serve small/local files safely.
    function makeLegacyReader(stream, size, internalReadSize) {
        var closed = false;

        return {
            implementation: 'Tizen FileStream (legacy)',

            getSize: function (cb) {
                later(function () { cb(null, size); });
            },

            readRange: function (offset, length, cb) {
                if (offset > 0x7fffffff) {
                    later(function () { cb(Error('legacy FileStream cannot address offsets above 2 GiB')); });
                    return;
                }
                if (closed || !isValidRange(offset, length, size)) {
                    later(function () { cb(Error('invalid/closed range')); });
                    return;
                }

                length = Math.min(length, size - offset);
                var out = new Uint8Array(length);
                var written = 0;

                try {
                    stream.position = offset;
                } catch (e) {
                    cb(e);
                    return;
                }

                function readNextPart() {
                    if (closed) {
                        cb(Error('reader closed'));
                        return;
                    }
                    if (written === length) {
                        cb(null, out.buffer);
                        return;
                    }

                    try {
                        var chunk = stream.readBytes(Math.min(internalReadSize, length - written));
                        if (!chunk.length) {
                            cb(Error('unexpected EOF'));
                            return;
                        }

                        out.set(chunk, written);
                        written += chunk.length;
                        later(readNextPart);
                    } catch (e) {
                        cb(e);
                    }
                }

                later(readNextPart);
            },

            close: function () {
                if (closed) return;
                closed = true;
                try { stream.close(); } catch (e) {}
            }
        };
    }

    function openIncrementalReader(file, options, cb) {
        if (file && file.readRange && file.getSize) {
            later(function () { cb(null, file); });
            return;
        }

        if (typeof tizen === 'undefined' || !tizen.filesystem) {
            later(function () { cb(Error('Tizen filesystem unavailable')); });
            return;
        }

        var path = filePathOf(file);
        var uri = file && typeof file.toURI === 'function' ? file.toURI() : String(file || '');
        var size = file && Number(file.fileSize);
        var internalReadSize = Math.min(options.internalReadSize, options.chunkSize);

        function tryXhrRangeReader(onUnavailable) {
            if (typeof XMLHttpRequest === 'undefined' || !uri || uri.indexOf('file://') !== 0 ||
                !Number.isSafeInteger(size)) {
                onUnavailable();
                return;
            }

            var xhrReader = makeXhrRangeReader(uri, size, options.xhrRangeTimeoutMs);
            xhrReader.readRange(0, MP4_HEADER_READ_BYTES, function (err, buffer) {
                if (!err && buffer && buffer.byteLength === MP4_HEADER_READ_BYTES) {
                    cb(null, xhrReader);
                    return;
                }

                onUnavailable();
            });
        }

        function openTizenReader(resolvedFile) {
            if (tryModernReader()) return;

            if (resolvedFile) {
                openLegacyReader(resolvedFile);
            } else if (file && file.openStream) {
                openLegacyReader(file);
            } else {
                cb(Error('no usable local file reader'));
            }
        }

        function tryModernReader() {
            if (!tizen.filesystem.openFile) return false;
            if (!Number.isSafeInteger(size)) return false;

            var handle;
            try {
                handle = tizen.filesystem.openFile(path, 'r');
            } catch (e) {
                return false;
            }

            cb(null, makeModernReader(handle, size, internalReadSize));
            return true;
        }

        function openLegacyReader(resolvedFile) {
            size = Number(resolvedFile.fileSize);
            try {
                resolvedFile.openStream(
                    'r',
                    function (stream) { cb(null, makeLegacyReader(stream, size, internalReadSize)); },
                    cb
                );
            } catch (e) {
                cb(e);
            }
        }

        if (Number.isSafeInteger(size)) {
            tryXhrRangeReader(function () { openTizenReader(file && file.openStream ? file : null); });
            return;
        }

        try {
            tizen.filesystem.resolve(
                path,
                function (resolvedFile) {
                    size = Number(resolvedFile.fileSize);
                    path = resolvedFile.fullPath;
                    if (typeof resolvedFile.toURI === 'function') uri = resolvedFile.toURI();

                    tryXhrRangeReader(function () { openTizenReader(resolvedFile); });
                },
                cb,
                'r'
            );
        } catch (e) {
            cb(e);
        }
    }

    function normalizeIncrementalOptions(handlerOptions) {
        var chunkSize = Math.max(
            MIN_CHUNK_BYTES,
            Math.min(handlerOptions.chunkSize || DEFAULT_CHUNK_BYTES, MAX_CHUNK_BYTES)
        );

        return {
            chunkSize: chunkSize,
            internalReadSize: Math.max(
                MIN_INTERNAL_READ_BYTES,
                handlerOptions.internalReadSize || DEFAULT_INTERNAL_READ_BYTES
            ),
            maxMoovBytes: handlerOptions.maxMoovBytes || DEFAULT_MAX_MOOV_BYTES,
            maxTailSearchBytes: handlerOptions.maxTailSearchBytes || DEFAULT_MAX_TAIL_SEARCH_BYTES,
            xhrRangeTimeoutMs: handlerOptions.xhrRangeTimeoutMs || DEFAULT_XHR_RANGE_TIMEOUT_MS,
            tailSearchChunkBytes: Math.max(
                MP4_HEADER_READ_BYTES,
                Math.min(handlerOptions.tailSearchChunkBytes || DEFAULT_TAIL_SEARCH_CHUNK_BYTES, chunkSize)
            ),
            maxSampleBytes: Math.min(
                handlerOptions.maxSampleBytes || DEFAULT_MAX_SAMPLE_BYTES,
                chunkSize
            )
        };
    }

    function readBoxHeader(reader, offset, fileSize, cb) {
        if (offset >= fileSize) {
            cb(null, null);
            return;
        }

        reader.readRange(offset, Math.min(MP4_HEADER_READ_BYTES, fileSize - offset), function (err, buffer) {
            if (err) {
                cb(err);
                return;
            }

            try {
                var view = new DataView(buffer);
                if (view.byteLength < 8) throw Error('truncated MP4 box header');

                var size = view.getUint32(0);
                var type = String.fromCharCode(
                    view.getUint8(4), view.getUint8(5),
                    view.getUint8(6), view.getUint8(7)
                );
                var headerSize = 8;

                if (size === 1) {
                    if (view.byteLength < 16) throw Error('truncated extended MP4 box header');
                    var hi = view.getUint32(8);
                    var lo = view.getUint32(12);
                    size = hi * 0x100000000 + lo;
                    headerSize = 16;
                } else if (size === 0) {
                    size = fileSize - offset;
                }

                var remaining = fileSize - offset;
                var boxDetails = 'type=' + JSON.stringify(type) +
                                 ' size=' + size +
                                 ' remaining=' + remaining;

                if (size < headerSize) throw Error('invalid MP4 box size (' + boxDetails + ')');
                if (offset + size > fileSize) throw Error('MP4 box exceeds file (' + boxDetails + ')');

                cb(null, {
                    type: type,
                    start: offset,
                    body: offset + headerSize,
                    size: size,
                    end: offset + size
                });
            } catch (e) {
                cb(Error('MP4 box header at ' + offset + ': ' + e.message));
            }
        });
    }

    function isSupportedTextTrack(track) {
        var isSubtitleHandler = track.handler === 'subt' ||
                                track.handler === 'sbtl' ||
                                track.handler === 'text';
        var isSupportedCodec = track.codec === 'tx3g' ||
                               track.codec === 'text' ||
                               track.codec === 'mov_';

        return isSubtitleHandler &&
               isSupportedCodec &&
               track.timescale &&
               track.sampleSizes &&
               track.sampleSizes.length &&
               track.chunkOffsets &&
               track.chunkOffsets.length &&
               track.stsc &&
               track.stsc.length;
    }

    function makeIncrementalTrack(track) {
        return {
            id: track.id,
            lang: track.lang || '',
            codec: track.codec,
            cues: []
        };
    }

    function extractIncremental(file, handlers) {
        handlers = handlers || {};

        var cancelled = false;
        var finished = false;
        var reader = null;
        var fileSize = 0;
        var published = false;
        var lastLoggedPercent = -5;
        var triedTailMoovSearch = false;
        var options = normalizeIncrementalOptions(handlers);

        function safeCallback(name) {
            if (cancelled || typeof handlers[name] !== 'function') return;

            try {
                handlers[name].apply(null, [].slice.call(arguments, 1));
            } catch (e) {
                warn(name + ' callback: ' + e.message);
            }
        }

        function closeReader() {
            if (!reader) return;

            try { reader.close(); } catch (e) {}
            reader = null;
        }

        function fail(err) {
            if (cancelled || finished) return;

            finished = true;
            closeReader();
            warn('parse error: ' + (err.message || err));
            safeCallback('onError', err instanceof Error ? err : Error(String(err)));
        }

        function reportProgress(processed, total) {
            safeCallback('onProgress', processed, total || fileSize);

            var denominator = total || fileSize;
            var percent = denominator ? Math.floor(processed * 100 / denominator) : 100;
            if (percent >= lastLoggedPercent + 5) {
                lastLoggedPercent = percent;
                log('processed ' + percent + '%');
            }
        }

        function publishTracksOnce(tracks) {
            if (published) return;

            published = true;
            log('discovered ' + tracks.length + ' supported text track(s)');
            safeCallback('onTracks', tracks);
        }

        function finish(tracks) {
            if (cancelled || finished) return;

            finished = true;
            closeReader();
            log('complete: ' + tracks.map(function (track) {
                return track.id + '=' + track.cues.length;
            }).join(', '));
            safeCallback('onComplete', tracks);
        }

        function readMoovBox(moovBox) {
            if (moovBox.size > options.maxMoovBytes) {
                fail(Error('moov box too large for bounded metadata read: ' + moovBox.size + ' bytes'));
                return;
            }

            reader.readRange(moovBox.body, moovBox.end - moovBox.body, function (err, buffer) {
                if (err) {
                    fail(err);
                    return;
                }

                var textTrackMetadata;
                try {
                    textTrackMetadata = parseMp4(buffer).filter(isSupportedTextTrack);
                } catch (e) {
                    fail(e);
                    return;
                }

                var liveTracks = textTrackMetadata.map(makeIncrementalTrack);
                publishTracksOnce(liveTracks);

                if (!liveTracks.length) {
                    finish(liveTracks);
                    return;
                }

                extractTrackSamples(textTrackMetadata, liveTracks);
            });
        }

        function findMoovInBuffer(buffer, baseOffset) {
            var view = new DataView(buffer);

            for (var typeOffset = view.byteLength - 4; typeOffset >= 4; typeOffset--) {
                if (view.getUint8(typeOffset) !== 0x6D ||     // m
                    view.getUint8(typeOffset + 1) !== 0x6F || // o
                    view.getUint8(typeOffset + 2) !== 0x6F || // o
                    view.getUint8(typeOffset + 3) !== 0x76) { // v
                    continue;
                }

                var boxStart = typeOffset - 4;
                var size = view.getUint32(boxStart);
                var headerSize = 8;

                if (size === 1) {
                    if (boxStart + 16 > view.byteLength) continue;

                    var hi = view.getUint32(boxStart + 8);
                    var lo = view.getUint32(boxStart + 12);
                    size = hi * 0x100000000 + lo;
                    headerSize = 16;
                } else if (size === 0) {
                    size = view.byteLength - boxStart;
                }

                var absoluteStart = baseOffset + boxStart;
                var absoluteEnd = absoluteStart + size;
                if (size < headerSize || absoluteEnd > fileSize) continue;

                return {
                    type: 'moov',
                    start: absoluteStart,
                    body: absoluteStart + headerSize,
                    size: size,
                    end: absoluteEnd
                };
            }

            return null;
        }

        function bufferContainsBoxType(buffer, type) {
            var view = new DataView(buffer);
            var a = type.charCodeAt(0);
            var b = type.charCodeAt(1);
            var c = type.charCodeAt(2);
            var d = type.charCodeAt(3);

            for (var i = 0; i <= view.byteLength - 4; i++) {
                if (view.getUint8(i) === a &&
                    view.getUint8(i + 1) === b &&
                    view.getUint8(i + 2) === c &&
                    view.getUint8(i + 3) === d) {
                    return true;
                }
            }

            return false;
        }

        function findMoovNearTail(originalErr) {
            if (triedTailMoovSearch) {
                fail(originalErr || Error('moov box not found'));
                return;
            }
            triedTailMoovSearch = true;

            var searchBytes = Math.min(options.maxTailSearchBytes, fileSize);
            var searchStart = fileSize - searchBytes;
            var sawMoof = false;

            function failAfterTailSearch() {
                var originalMessage = originalErr && (originalErr.message || originalErr);
                fail(Error('moov box not found after top-level scan and tail search' +
                           (sawMoof ? ' (saw fragmented MP4 boxes)' : '') +
                           (originalMessage ? '; original error: ' + originalMessage : '')));
            }

            function searchChunk(chunkEnd) {
                if (cancelled) return;

                if (chunkEnd <= searchStart) {
                    failAfterTailSearch();
                    return;
                }

                var chunkStart = Math.max(searchStart, chunkEnd - options.tailSearchChunkBytes);
                reader.readRange(chunkStart, chunkEnd - chunkStart, function (err, buffer) {
                    if (err) {
                        fail(err);
                        return;
                    }

                    sawMoof = sawMoof || bufferContainsBoxType(buffer, 'moof');

                    var moovBox = findMoovInBuffer(buffer, chunkStart);
                    if (moovBox) {
                        log('found moov by tail search at ' + moovBox.start + ' size=' + moovBox.size);
                        readMoovBox(moovBox);
                        return;
                    }

                    if (chunkStart === searchStart) {
                        failAfterTailSearch();
                        return;
                    }

                    later(function () {
                        searchChunk(chunkStart + TAIL_SEARCH_OVERLAP_BYTES);
                    });
                });
            }

            searchChunk(fileSize);
        }

        function extractTrackSamples(metadataTracks, liveTracks) {
            var trackIndex = 0;

            function nextTrack() {
                if (cancelled) return;
                if (trackIndex >= metadataTracks.length) {
                    finish(liveTracks);
                    return;
                }

                extractOneTrack(metadataTracks[trackIndex], liveTracks[trackIndex], function (err) {
                    if (err) fail(err);
                    else {
                        trackIndex++;
                        later(nextTrack);
                    }
                });
            }

            nextTrack();
        }

        function extractOneTrack(metadata, liveTrack, cb) {
            var offsets = computeSampleOffsets(
                metadata.stsc,
                metadata.chunkOffsets,
                metadata.sampleSizes.length,
                metadata.sampleSizes
            );
            var times = expandStts(metadata.stts, metadata.sampleSizes.length);
            var sampleIndex = 0;

            function nextSample() {
                if (cancelled) return;
                if (sampleIndex >= metadata.sampleSizes.length) {
                    safeCallback('onCues', liveTrack.id, liveTrack.cues);
                    cb(null);
                    return;
                }

                var size = metadata.sampleSizes[sampleIndex];
                var offset = offsets[sampleIndex];
                var time = times[sampleIndex];
                var currentSample = sampleIndex;
                sampleIndex++;

                reportProgress(sampleIndex, metadata.sampleSizes.length);

                if (!size) {
                    later(nextSample);
                    return;
                }
                if (!Number.isSafeInteger(offset) || offset < 0 || offset + size > fileSize) {
                    cb(Error('subtitle sample points outside file at index ' + currentSample));
                    return;
                }
                if (size > options.maxSampleBytes) {
                    warn('skipping oversized subtitle sample at ' + offset);
                    later(nextSample);
                    return;
                }

                reader.readRange(offset, size, function (err, buffer) {
                    if (err) {
                        cb(err);
                        return;
                    }

                    var text = decodeTextSample(buffer, 0, buffer.byteLength).trim();
                    if (text) {
                        liveTrack.cues.push({
                            start: time.start / metadata.timescale,
                            end: time.end / metadata.timescale,
                            text: text
                        });

                        safeCallback('onCues', liveTrack.id, liveTrack.cues);
                    }

                    later(nextSample);
                });
            }

            nextSample();
        }

        function findMoov(offset) {
            if (cancelled) return;

            readBoxHeader(reader, offset, fileSize, function (err, box) {
                if (err) {
                    findMoovNearTail(err);
                    return;
                }
                if (!box) {
                    findMoovNearTail(Error('moov box not found'));
                    return;
                }

                if (box.type === 'moov') {
                    log('found moov at ' + box.start + ' size=' + box.size);
                    readMoovBox(box);
                } else {
                    reportProgress(box.end, fileSize);
                    later(function () { findMoov(box.end); });
                }
            });
        }

        openIncrementalReader(file, options, function (err, openedReader) {
            if (cancelled) {
                if (openedReader) openedReader.close();
                return;
            }
            if (err) {
                fail(err);
                return;
            }

            reader = openedReader;
            reader.getSize(function (sizeErr, size) {
                if (sizeErr) {
                    fail(sizeErr);
                    return;
                }

                fileSize = Number(size);
                if (!Number.isSafeInteger(fileSize)) {
                    fail(Error('invalid file size'));
                    return;
                }

                log('file size=' + fileSize +
                    ' reader=' + (reader.implementation || 'custom') +
                    ' chunk=' + options.chunkSize);
                findMoov(0);
            });
        });

        return {
            cancel: function (reason) {
                if (cancelled || finished) return;

                cancelled = true;
                closeReader();
                log('cancelled' + (reason ? ': ' + reason : ''));
            }
        };
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
        extractIncremental: extractIncremental,
        cuesToSrt:     cuesToSrt,
        _extractCueLists: extractCueLists,
        writeSrtToTmp: writeSrtToTmp
    };
})();

// CommonJS export is ignored by Tizen/browser builds, but lets Node tests
// require this parser directly.
if (typeof module !== 'undefined' && module.exports) module.exports = Mp4Subs;

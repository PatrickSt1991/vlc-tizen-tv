/* MKV / WebM embedded-subtitle extractor.
 *
 * Mirrors mp4-subs.js but for the EBML container.  Walks the Segment ->
 * Tracks / Cluster tree, finds text-subtitle tracks (S_TEXT/UTF8,
 * S_TEXT/ASS, S_TEXT/SSA), collects per-cluster Block payloads, and
 * emits SRT.
 *
 * Why this exists: same firmware bug we hit for MP4 — AVPlay's
 * setSelectTrack('TEXT') only fires onsubtitlechange once for embedded
 * tracks on Tizen 5.0.  Routing extracted subs through
 * setExternalSubtitlePath bypasses it.
 *
 * Bitmap subs (VobSub, PGS) are skipped — they can't be rendered as
 * text in this player.
 *
 * Same in-memory size cap applies as MP4 — future task is Range-based
 * partial reads (would benefit both extractors).
 */

var MkvSubs = (function () {

    var MAX_FULL_LOAD_BYTES = 200 * 1024 * 1024;

    /* ── EBML primitives ──────────────────────────────────────────────── */

    /* Decode a variable-length integer.  When keepMarker=true the leading
     * '1' bit is kept (used for element IDs); when false it's stripped
     * (used for element sizes).  Returns { value, length }. */
    function readVint(view, off, keepMarker) {
        if (off >= view.byteLength) throw new Error('vint past EOF');
        var first = view.getUint8(off);
        if (first === 0) throw new Error('invalid vint (leading 0 byte)');
        var len = 1;
        var mask = 0x80;
        while (!(first & mask)) {
            len++; mask >>= 1;
            if (len > 8) throw new Error('vint too long');
        }
        var val = keepMarker ? first : (first & (mask - 1));
        for (var i = 1; i < len; i++) {
            val = val * 256 + view.getUint8(off + i);
        }
        return { value: val, length: len };
    }

    function readElement(view, off) {
        var idV   = readVint(view, off, true);
        var sizeV = readVint(view, off + idV.length, false);
        var bodyOff = off + idV.length + sizeV.length;
        return {
            id:      idV.value,
            size:    sizeV.value,
            bodyOff: bodyOff,
            bodyEnd: bodyOff + sizeV.value
        };
    }

    function walk(view, off, end, visitor) {
        while (off < end - 1) {
            var el;
            try { el = readElement(view, off); }
            catch (e) { return; }
            if (el.bodyEnd > end) return;
            visitor(el.id, el.bodyOff, el.bodyEnd);
            off = el.bodyEnd;
        }
    }

    function readUint(view, off, len) {
        var v = 0;
        for (var i = 0; i < len; i++) v = v * 256 + view.getUint8(off + i);
        return v;
    }
    function readAscii(view, off, len) {
        var s = '';
        for (var i = 0; i < len; i++) {
            var c = view.getUint8(off + i);
            if (c === 0) break;
            s += String.fromCharCode(c);
        }
        return s;
    }
    function readUtf8(view, off, len) {
        if (len <= 0) return '';
        var bytes = new Uint8Array(view.buffer, view.byteOffset + off, len);
        try { return new TextDecoder('utf-8').decode(bytes); }
        catch (e) {
            var s = '';
            for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
            return s;
        }
    }

    /* ── Element IDs we care about ────────────────────────────────────── */
    var ID_SEGMENT       = 0x18538067;
    var ID_INFO          = 0x1549A966;
    var ID_TIMECODESCALE = 0x2AD7B1;
    var ID_TRACKS        = 0x1654AE6B;
    var ID_TRACKENTRY    = 0xAE;
    var ID_TRACKNUMBER   = 0xD7;
    var ID_TRACKTYPE     = 0x83;
    var ID_CODECID       = 0x86;
    var ID_LANGUAGE      = 0x22B59C;
    var ID_CLUSTER       = 0x1F43B675;
    var ID_TIMECODE      = 0xE7;
    var ID_SIMPLEBLOCK   = 0xA3;
    var ID_BLOCKGROUP    = 0xA0;
    var ID_BLOCK         = 0xA1;
    var ID_BLOCKDURATION = 0x9B;

    /* ── Track entry parser (returns subtitle tracks only) ───────────── */
    function parseTrackEntry(view, off, end) {
        var t = { number: 0, type: 0, codec: '', lang: '' };
        walk(view, off, end, function (id, o, e) {
            switch (id) {
                case ID_TRACKNUMBER: t.number = readUint(view, o, e - o); break;
                case ID_TRACKTYPE:   t.type   = readUint(view, o, e - o); break;
                case ID_CODECID:     t.codec  = readAscii(view, o, e - o); break;
                case ID_LANGUAGE:    t.lang   = readAscii(view, o, e - o); break;
            }
        });
        return t;
    }

    /* ── Block / SimpleBlock body parser ─────────────────────────────────
     *
     * Layout:
     *   - VINT track number
     *   - i16be timestamp relative to the enclosing cluster (in ticks)
     *   - u8 flags (lacing bits in 0x06, keyframe in 0x80 for SimpleBlock)
     *   - body (the subtitle text for S_TEXT/*)
     *
     * Returns { trackNum, relTs, dataOff, dataLen, duration } or null if
     * the block belongs to a non-subtitle track. */
    function parseBlock(view, off, end, isSubTrack) {
        if (end - off < 4) return null;
        var trackV;
        try { trackV = readVint(view, off, false); } catch (e) { return null; }
        if (!isSubTrack(trackV.value)) return null;
        var p = off + trackV.length;
        if (p + 3 > end) return null;
        var relTs = view.getInt16(p);
        p += 3;     // i16 ts (2) + u8 flags (1)
        return {
            trackNum: trackV.value,
            relTs:    relTs,
            dataOff:  p,
            dataLen:  end - p,
            duration: 0
        };
    }
    function parseBlockGroup(view, off, end, isSubTrack) {
        var b = null;
        var dur = 0;
        walk(view, off, end, function (id, o, e) {
            if (id === ID_BLOCK)              b = parseBlock(view, o, e, isSubTrack);
            else if (id === ID_BLOCKDURATION) dur = readUint(view, o, e - o);
        });
        if (b) b.duration = dur;
        return b;
    }
    function parseCluster(view, off, end, isSubTrack) {
        var ct = 0;
        var blocks = [];
        walk(view, off, end, function (id, o, e) {
            switch (id) {
                case ID_TIMECODE:
                    ct = readUint(view, o, e - o);
                    break;
                case ID_SIMPLEBLOCK:
                    var sb = parseBlock(view, o, e, isSubTrack);
                    if (sb) blocks.push(sb);
                    break;
                case ID_BLOCKGROUP:
                    var bg = parseBlockGroup(view, o, e, isSubTrack);
                    if (bg) blocks.push(bg);
                    break;
            }
        });
        return { clusterTc: ct, blocks: blocks };
    }

    /* ── Top-level parse ─────────────────────────────────────────────── */
    function parseMkv(buf) {
        var view = new DataView(buf);
        var tcScaleNs = 1000000;     // default 1 ms / tick
        var subTracks = {};
        var clusters  = [];
        function isSubTrack(n) { return !!subTracks[n]; }

        walk(view, 0, buf.byteLength, function (id, off, end) {
            if (id !== ID_SEGMENT) return;
            walk(view, off, end, function (sid, soff, send) {
                switch (sid) {
                    case ID_INFO:
                        walk(view, soff, send, function (iid, io, ie) {
                            if (iid === ID_TIMECODESCALE)
                                tcScaleNs = readUint(view, io, ie - io);
                        });
                        break;
                    case ID_TRACKS:
                        walk(view, soff, send, function (tid, to, te) {
                            if (tid !== ID_TRACKENTRY) return;
                            var t = parseTrackEntry(view, to, te);
                            if (t.type !== 17) return;                  // 17 = subtitle
                            if (t.codec === 'S_VOBSUB') return;
                            if (/PGS/.test(t.codec))    return;
                            if (t.codec.indexOf('S_TEXT/') !== 0) return;
                            subTracks[t.number] = t;
                        });
                        break;
                    case ID_CLUSTER:
                        if (!Object.keys(subTracks).length) return;
                        var c = parseCluster(view, soff, send, isSubTrack);
                        if (c.blocks.length) clusters.push(c);
                        break;
                }
            });
        });

        return buildCueLists(view, tcScaleNs, subTracks, clusters);
    }

    function buildCueLists(view, tcScaleNs, subTracks, clusters) {
        var toMs = tcScaleNs / 1000000;
        var byTrack = {};
        for (var tn in subTracks) {
            byTrack[tn] = {
                id:    subTracks[tn].number,
                lang:  subTracks[tn].lang || '',
                codec: subTracks[tn].codec,
                cues:  []
            };
        }
        for (var i = 0; i < clusters.length; i++) {
            var c = clusters[i];
            for (var j = 0; j < c.blocks.length; j++) {
                var b = c.blocks[j];
                var t = byTrack[b.trackNum];
                if (!t) continue;
                var startMs = (c.clusterTc + b.relTs) * toMs;
                var durMs   = (b.duration || 0) * toMs;
                if (durMs <= 0) durMs = 5000;           // fallback if no BlockDuration

                var text = readUtf8(view, b.dataOff, b.dataLen).trim();
                if (!text) continue;
                if (t.codec.indexOf('ASS') >= 0 || t.codec.indexOf('SSA') >= 0) {
                    text = cleanAssLine(text);
                }
                if (!text) continue;
                t.cues.push({
                    start: startMs / 1000,
                    end:   (startMs + durMs) / 1000,
                    text:  text
                });
            }
        }
        var out = [];
        for (var k in byTrack) {
            if (byTrack[k].cues.length) {
                byTrack[k].cues.sort(function (a, b) { return a.start - b.start; });
                out.push(byTrack[k]);
            }
        }
        return out;
    }

    /* ASS dialog line layout:
     *   ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text
     * Keep only the last field (after the 8th comma) and strip override
     * tags + linebreak escapes. */
    function cleanAssLine(s) {
        var commas = 0;
        var idx = 0;
        for (var i = 0; i < s.length && commas < 8; i++) {
            if (s.charAt(i) === ',') { commas++; idx = i + 1; }
        }
        var text = s.substring(idx);
        return text
            .replace(/\{[^}]*\}/g, '')
            .replace(/\\N/g, '\n')
            .replace(/\\n/g, '\n')
            .replace(/\\h/g, ' ')
            .trim();
    }

    /* ── SRT formatting ──────────────────────────────────────────────── */
    function fmtSrtTime(seconds) {
        if (seconds < 0) seconds = 0;
        var ms = Math.floor((seconds - Math.floor(seconds)) * 1000);
        var s = Math.floor(seconds);
        var h = Math.floor(s / 3600); s -= h * 3600;
        var m = Math.floor(s / 60);   s -= m * 60;
        var p2 = function (n) { return n < 10 ? '0' + n : '' + n; };
        var p3 = function (n) { return n < 10 ? '00' + n : n < 100 ? '0' + n : '' + n; };
        return p2(h) + ':' + p2(m) + ':' + p2(s) + ',' + p3(ms);
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

    /* ── Public ──────────────────────────────────────────────────────── */
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
                cb(new Error('MKV too large for in-memory extraction: ' +
                             Math.round(e.total / 1048576) + ' MB > ' +
                             Math.round(MAX_FULL_LOAD_BYTES / 1048576) + ' MB'));
            }
        };
        xhr.onload = function () {
            if (aborted) return;
            if (!xhr.response) { cb(new Error('empty XHR response')); return; }
            if (xhr.response.byteLength > MAX_FULL_LOAD_BYTES) {
                cb(new Error('MKV too large: ' + xhr.response.byteLength + ' bytes'));
                return;
            }
            try {
                var subs = parseMkv(xhr.response);
                for (var i = 0; i < subs.length; i++) subs[i].srt = cuesToSrt(subs[i].cues);
                cb(null, subs);
            } catch (e) { cb(e); }
        };
        xhr.onerror = function () {
            if (!aborted) cb(new Error('XHR failed loading ' + uri));
        };
        xhr.send();
    }

    /* writeSrtToTmp is identical across formats — reuse Mp4Subs' helper. */
    function writeSrtToTmp(srt, name, cb) {
        if (typeof Mp4Subs !== 'undefined' && Mp4Subs.writeSrtToTmp) {
            Mp4Subs.writeSrtToTmp(srt, name, cb);
        } else {
            cb(new Error('Mp4Subs.writeSrtToTmp not available'));
        }
    }

    return {
        extract:       extract,
        writeSrtToTmp: writeSrtToTmp,
        cuesToSrt:     cuesToSrt
    };
})();

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
 * extract() still loads the whole file, so it is capped at
 * MAX_FULL_LOAD_BYTES.  listTracks() does not: it Range-reads just the
 * header, so the CC menu can list every track in a file far too big to
 * extract from.
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
    var ID_LANGUAGE_IETF = 0x22B59D;   // BCP-47 tag; the only one with a region
    var ID_TRACKNAME     = 0x536E;     // human label: 'SDH', 'Latin America'
    var ID_FLAGDEFAULT   = 0x88;
    var ID_FLAGFORCED    = 0x55AA;
    var ID_FLAGHEARIMP   = 0x55AB;
    var ID_CODECPRIVATE  = 0x63A2;
    var ID_CLUSTER       = 0x1F43B675;
    var ID_TIMECODE      = 0xE7;
    var ID_SIMPLEBLOCK   = 0xA3;
    var ID_BLOCKGROUP    = 0xA0;
    var ID_BLOCK         = 0xA1;
    var ID_BLOCKDURATION = 0x9B;

    /* ── Track entry parser (returns subtitle tracks only) ───────────── */
    function parseTrackEntry(view, off, end) {
        var t = {
            number: 0, type: 0, codec: '', lang: '', langIetf: '', name: '',
            isDefault: false, forced: false, hearingImpaired: false, priv: ''
        };
        walk(view, off, end, function (id, o, e) {
            switch (id) {
                case ID_TRACKNUMBER: t.number = readUint(view, o, e - o); break;
                case ID_TRACKTYPE:   t.type   = readUint(view, o, e - o); break;
                case ID_CODECID:     t.codec  = readAscii(view, o, e - o); break;
                case ID_LANGUAGE:    t.lang   = readAscii(view, o, e - o); break;
                case ID_LANGUAGE_IETF: t.langIetf = readAscii(view, o, e - o); break;
                case ID_TRACKNAME:   t.name   = readUtf8(view, o, e - o); break;
                case ID_FLAGDEFAULT: t.isDefault = !!readUint(view, o, e - o); break;
                case ID_FLAGFORCED:  t.forced   = !!readUint(view, o, e - o); break;
                case ID_FLAGHEARIMP: t.hearingImpaired = !!readUint(view, o, e - o); break;
                /* For S_TEXT/ASS this is the whole script header, styles
                 * included — the only place an MKV keeps [V4+ Styles]. */
                case ID_CODECPRIVATE: t.priv = readUtf8(view, o, e - o); break;
            }
        });
        t.lang = bestLangTag(t);
        return t;
    }

    /* Streaming muxes tag every track twice — Language 'spa' alongside
     * LanguageBCP47 'es-419'.  Only the BCP-47 form distinguishes the
     * regional variants a 40-track file is mostly made of, and
     * LanguageList.matchScore understands both spellings, so preferring it
     * when it carries a subtag costs nothing and keeps 'Latin America'
     * apart from 'es-ES'. */
    function bestLangTag(t) {
        if (t.langIetf && t.langIetf.indexOf('-') > 0) return t.langIetf;
        return t.lang || t.langIetf || '';
    }

    function isSubtitleTrack(t) { return t.type === 17; }   // 17 = subtitle

    /* Text subs this player can paint.  VobSub and PGS carry bitmaps, so
     * they get listed but never extracted. */
    function isTextSubtitleTrack(t) {
        if (!isSubtitleTrack(t)) return false;
        if (t.codec === 'S_VOBSUB' || /PGS/.test(t.codec)) return false;
        return t.codec.indexOf('S_TEXT/') === 0;
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
                            if (!isTextSubtitleTrack(t)) return;
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
            var codec = subTracks[tn].codec;
            var isAss = codec.indexOf('ASS') >= 0 || codec.indexOf('SSA') >= 0;
            byTrack[tn] = {
                id:    subTracks[tn].number,
                lang:  subTracks[tn].lang || '',
                codec: codec,
                /* Style table parsed once per track, not per cue. */
                assFile: (isAss && typeof AssStyle !== 'undefined')
                    ? AssStyle.forFile(subTracks[tn].priv || '')
                    : null,
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
                var runs = null;
                if (t.codec.indexOf('ASS') >= 0 || t.codec.indexOf('SSA') >= 0) {
                    if (t.assFile) {
                        /* Inline {\c&H..&} overrides plus the CodecPrivate
                         * [V4+ Styles] defaults become paintable runs. */
                        var split = splitAssLine(text);
                        runs = t.assFile.runs(split.text, split.fields[2] || '');
                        text = AssStyle.plainText(runs);
                        if (AssStyle.isPlain(runs)) runs = null;
                    } else {
                        text = cleanAssLine(text);
                    }
                }
                if (!text) continue;
                t.cues.push({
                    start: startMs / 1000,
                    end:   (startMs + durMs) / 1000,
                    text:  text,
                    runs:  runs
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
     * Returns the 8 leading fields (Style is fields[2], needed to look the
     * cue's colour up in [V4+ Styles]) plus the Text remainder, which may
     * itself contain commas. */
    function splitAssLine(s) {
        var fields = [];
        var idx = 0;
        for (var i = 0; i < s.length && fields.length < 8; i++) {
            if (s.charAt(i) === ',') { fields.push(s.substring(idx, i)); idx = i + 1; }
        }
        return { fields: fields, text: s.substring(idx) };
    }

    /* Fallback for when ass-style.js isn't loaded (Node tests requiring this
     * module directly): flatten to plain text exactly as before. */
    function cleanAssLine(s) {
        return splitAssLine(s).text
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

    /* ── Header-only track listing ────────────────────────────────────
     *
     * The whole track table sits in the Tracks element near the front of the
     * file — 2.4 KB even for a 40-track streaming mux — so listing every
     * track costs one short Range read instead of the entire movie.
     *
     * This is the only path that sees all of them.  AVPlay's
     * getTotalTrackInfo() truncates its own return array: a file with 1
     * video + 1 audio + 40 subtitle tracks comes back with 32 entries, and
     * the ten it silently drops are the last in file order — which is
     * exactly where muxers put the less common languages.  extract() can't
     * stand in either, because it refuses anything over
     * MAX_FULL_LOAD_BYTES.  player.js uses this list to build the CC menu
     * and to keep AVPlay's track indices lined up with the container. */

    var HEADER_WINDOW_BYTES      = 128 * 1024;
    var MAX_HEADER_PROBE_BYTES   = 16 * 1024 * 1024;
    var MAX_TRACKS_ELEMENT_BYTES = 4 * 1024 * 1024;
    var MAX_RANGE_RESPONSE_BYTES = 32 * 1024 * 1024;

    function uriOf(source) {
        if (!source) return '';
        if (typeof source === 'string') return source;
        if (typeof source.toURI === 'function') {
            try { return source.toURI(); } catch (e) {}
        }
        return '';
    }

    /* Range reader over an http(s) URL.  Both things that serve us HTTP —
     * the bundled SMB proxy and the transcode server — answer 206 with a
     * Content-Range, which is also where the file size comes from. */
    function makeUrlRangeReader(uri) {
        var knownSize = -1;

        function request(start, length, cb) {
            var xhr = new XMLHttpRequest();
            try { xhr.open('GET', uri, true); } catch (e) { cb(e); return; }
            xhr.responseType = 'arraybuffer';
            try {
                xhr.setRequestHeader('Range', 'bytes=' + start + '-' + (start + length - 1));
            } catch (e) {}

            var aborted = false;
            /* A server that ignores Range answers 200 with the whole file.
             * Pulling a 6 GB movie into the WebView would take the app down,
             * so bail the moment the announced length gives it away. */
            xhr.onprogress = function (e) {
                if (aborted || !e || !e.lengthComputable) return;
                if (e.total <= MAX_RANGE_RESPONSE_BYTES) return;
                aborted = true;
                try { xhr.abort(); } catch (_) {}
                cb(Error('Range ignored by server (offered ' + e.total + ' bytes)'));
            };
            xhr.onload = function () {
                if (aborted) return;
                var cr = '';
                try { cr = xhr.getResponseHeader('Content-Range') || ''; } catch (e) {}
                var m = /\/\s*(\d+)\s*$/.exec(cr);
                if (m) knownSize = parseInt(m[1], 10);
                if (xhr.status !== 206 && xhr.status !== 200) {
                    cb(Error('HTTP ' + xhr.status + ' on range read'));
                    return;
                }
                if (xhr.status !== 206 && knownSize < 0) {
                    cb(Error('server does not honour Range requests'));
                    return;
                }
                if (!xhr.response) { cb(Error('empty range response')); return; }
                cb(null, xhr.response);
            };
            xhr.onerror = function () {
                if (!aborted) cb(Error('range read failed: ' + uri));
            };
            xhr.send();
        }

        return {
            implementation: 'XHR Range (URL)',
            getSize: function (cb) {
                if (knownSize >= 0) { cb(null, knownSize); return; }
                /* One-byte probe purely to read Content-Range's total. */
                request(0, 1, function (err) {
                    if (err) { cb(err); return; }
                    if (knownSize < 0) { cb(Error('no Content-Range on range read')); return; }
                    cb(null, knownSize);
                });
            },
            readRange: request,
            close: function () {}
        };
    }

    /* Local files borrow mp4-subs.js' reader, which already knows how to
     * address past 2 GiB on every Tizen FileStream vintage. */
    function openRangeReader(source, cb) {
        if (source && source.readRange && source.getSize) { cb(null, source); return; }

        var uri = uriOf(source);
        if (/^https?:/i.test(uri)) {
            if (typeof XMLHttpRequest === 'undefined') { cb(Error('no XMLHttpRequest')); return; }
            cb(null, makeUrlRangeReader(uri));
            return;
        }
        if (typeof Mp4Subs !== 'undefined' && Mp4Subs.openReader) {
            Mp4Subs.openReader(source, cb);
            return;
        }
        cb(Error('no range reader for ' + (uri || typeof source)));
    }

    /* Every TrackEntry in the file, in file order — video and audio
     * included, so callers can map a subtitle's position in the container
     * onto the indices AVPlay hands out. */
    function listTracks(source, cb) {
        var reader = null;
        var called = false;

        function done(err, tracks) {
            if (called) return;
            called = true;
            if (reader && reader !== source && reader.close) {
                try { reader.close(); } catch (e) {}
            }
            cb(err, tracks || []);
        }

        openRangeReader(source, function (oerr, r) {
            if (oerr) { done(oerr); return; }
            reader = r;
            reader.getSize(function (serr, size) {
                if (serr) { done(serr); return; }
                if (!(size > 0)) { done(Error('unknown file size')); return; }
                scanForTracks(reader, size, done);
            });
        });
    }

    /* Walk the Segment's direct children until Tracks turns up, seeking
     * over everything else — a fat SeekHead, cover-art Attachments — rather
     * than reading it. */
    function scanForTracks(reader, size, done) {
        var pos        = 0;
        var segmentEnd = size;
        var inSegment  = false;

        /* Longest element header we may need to sit fully inside the
         * window: a 4-byte id plus an 8-byte size. */
        var MAX_ELEMENT_HEADER = 12;

        function next() {
            if (pos + 2 > size || pos >= segmentEnd) { done(null, []); return; }
            if (pos > MAX_HEADER_PROBE_BYTES) {
                done(Error('no Tracks element in the first ' +
                           Math.round(MAX_HEADER_PROBE_BYTES / 1048576) + ' MB'));
                return;
            }

            var base = pos;
            reader.readRange(base, Math.min(HEADER_WINDOW_BYTES, size - base), function (err, buf) {
                if (err) { done(err); return; }

                var view = new DataView(buf);
                /* Consume as many sibling elements as this one window can
                 * describe before paying for another read — the whole
                 * pre-cluster header is usually a single window. */
                var at = 0;
                while (at + MAX_ELEMENT_HEADER <= buf.byteLength) {
                    var el;
                    try { el = readElement(view, at); }
                    catch (e) { done(e); return; }

                    var bodyAbs = base + el.bodyOff;
                    var endAbs  = bodyAbs + el.size;
                    /* An unknown-size element (the all-ones vint live
                     * streams use) or a truncated mux both read as "runs to
                     * EOF". */
                    if (!(endAbs > bodyAbs) || endAbs > size) endAbs = size;

                    if (!inSegment) {
                        if (el.id === ID_SEGMENT) {
                            inSegment  = true;
                            segmentEnd = endAbs;
                            at         = el.bodyOff;      // descend
                            continue;
                        }
                        at = endAbs - base;               // EBML header, Void, …
                        if (endAbs >= segmentEnd) { done(null, []); return; }
                        continue;
                    }
                    if (el.id === ID_TRACKS) {
                        readTracksElement(reader, bodyAbs, el.size, done);
                        return;
                    }
                    /* Tracks precedes the media in anything we can play, so
                     * once the clusters start there is nothing left to
                     * find. */
                    if (el.id === ID_CLUSTER) { done(null, []); return; }

                    at = endAbs - base;
                    if (endAbs >= segmentEnd) { done(null, []); return; }
                }

                pos = base + at;
                next();
            });
        }

        next();
    }

    function readTracksElement(reader, bodyAbs, len, done) {
        if (!(len > 0) || len > MAX_TRACKS_ELEMENT_BYTES) {
            done(Error('implausible Tracks element size: ' + len));
            return;
        }
        reader.readRange(bodyAbs, len, function (err, buf) {
            if (err) { done(err); return; }
            var view = new DataView(buf);
            var out  = [];
            walk(view, 0, buf.byteLength, function (id, o, e) {
                if (id === ID_TRACKENTRY) out.push(parseTrackEntry(view, o, e));
            });
            done(null, out);
        });
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
        extract:             extract,
        listTracks:          listTracks,
        isSubtitleTrack:     isSubtitleTrack,
        isTextSubtitleTrack: isTextSubtitleTrack,
        writeSrtToTmp:       writeSrtToTmp,
        cuesToSrt:           cuesToSrt
    };
})();

// CommonJS export is ignored by Tizen/browser builds, but lets Node tests
// require this parser directly.
if (typeof module !== 'undefined' && module.exports) module.exports = MkvSubs;

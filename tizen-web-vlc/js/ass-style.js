/* ASS / SSA text styling → renderable runs.
 *
 * Both subtitle paths used to throw every override tag away
 * (`text.replace(/\{[^}]*\}/g, '')`), so a line like
 *
 *     {\c&H00FFFF&}Tôi biết là bà sẽ ở đây mà{\c}
 *
 * lost its colour and got painted in the overlay's default white.  This
 * module turns that same line into a list of *runs* — contiguous spans of
 * text that share one appearance — which player.js paints as nested
 * <span>s.  Everything it cannot draw (positioning, karaoke, transforms,
 * vector drawings) is dropped exactly as before, so unstyled files behave
 * identically to the old code path.
 *
 * Scope is deliberate: primary colour + bold / italic / underline /
 * strikeout, from both the [V4+ Styles] table and inline overrides.
 * \pos, \an, \fs, \fn, \3c, \4c and friends are recognised only so they
 * can be skipped without leaking their arguments into the visible text.
 *
 * Loaded in browsers/Tizen as the global `AssStyle`; also CommonJS-exported
 * so tests/tizen-web-vlc/ass-style.test.js can require it directly.
 */

var AssStyle = (function () {
    'use strict';

    /* ── Colour ──────────────────────────────────────────────────────────
     *
     * ASS colours are BGR, not RGB — the single most common way to get
     * this wrong.  Two spellings appear in the wild:
     *
     *   inline override:  &HBBGGRR&    {\c&H00FFFF&}  → BB=00 GG=FF RR=FF
     *   style field:      &HAABBGGRR   &H00FFFFFF     → opaque white
     *
     * Short forms are legal (&HFF& means "red channel only"), and the
     * alpha byte is *transparency*: 00 = fully opaque, FF = invisible.
     * Zero-padding to 8 digits makes both spellings decode through one
     * path — a 6-digit BBGGRR pads to AA=00, i.e. opaque, which is right.
     */
    function decodeColour(raw) {
        if (raw == null) return null;
        var m = /&h([0-9a-f]{1,8})&?/i.exec(String(raw).replace(/\s+/g, ''));
        if (!m) return null;

        var hex = m[1];
        while (hex.length < 8) hex = '0' + hex;

        var aa = parseInt(hex.slice(0, 2), 16);
        var bb = parseInt(hex.slice(2, 4), 16);
        var gg = parseInt(hex.slice(4, 6), 16);
        var rr = parseInt(hex.slice(6, 8), 16);
        if (isNaN(aa) || isNaN(bb) || isNaN(gg) || isNaN(rr)) return null;

        var opacity = 1 - (aa / 255);
        return {
            r: rr, g: gg, b: bb,
            a: opacity,
            css: opacity >= 1
                ? '#' + hex2(rr) + hex2(gg) + hex2(bb)
                : 'rgba(' + rr + ',' + gg + ',' + bb + ',' + round2(opacity) + ')'
        };
    }

    function hex2(n) {
        var s = (n & 255).toString(16);
        return s.length < 2 ? '0' + s : s;
    }
    function round2(n) {
        return Math.round(n * 100) / 100;
    }

    /* Re-stamp an existing colour with a new alpha (\alpha / \1a apply to
     * whatever primary colour is currently in force). */
    function withAlpha(colour, opacity) {
        if (!colour) return null;
        return {
            r: colour.r, g: colour.g, b: colour.b,
            a: opacity,
            css: opacity >= 1
                ? '#' + hex2(colour.r) + hex2(colour.g) + hex2(colour.b)
                : 'rgba(' + colour.r + ',' + colour.g + ',' + colour.b + ',' +
                  round2(opacity) + ')'
        };
    }

    /* ── [V4+ Styles] table ──────────────────────────────────────────────
     *
     * The Format: line names the columns, so both ASS ([V4+ Styles]) and
     * older SSA ([V4 Styles], which swaps OutlineColour for TertiaryColour)
     * are read off the same index lookup rather than fixed positions.
     *
     * Bold/Italic/Underline/StrikeOut are 0 = off, -1 = on in SSA and
     * 0 / 1 in ASS — any non-zero means on.
     */
    function parseStyles(assText) {
        var lines = String(assText || '')
            .replace(/^\uFEFF/, '')
            .replace(/\r/g, '')
            .split('\n');

        var byName = {};
        var fmt = null;
        var inStyles = false;

        for (var i = 0; i < lines.length; i++) {
            var l = lines[i].trim();
            if (!l) continue;

            if (l.charAt(0) === '[' && l.charAt(l.length - 1) === ']') {
                var section = l.toLowerCase();
                inStyles = (section === '[v4+ styles]' || section === '[v4 styles]' ||
                            section === '[v4++ styles]');
                fmt = null;
                continue;
            }
            if (!inStyles) continue;

            if (/^format:/i.test(l)) {
                fmt = l.substring(7).split(',').map(function (s) {
                    return s.trim().toLowerCase();
                });
                continue;
            }
            if (!/^style:/i.test(l)) continue;
            if (!fmt) continue;                       // Style: before Format: — unusable

            var parts = l.substring(6).split(',');
            var name = String(field(parts, fmt, 'name') || '').trim();
            if (!name) continue;

            byName[name.toLowerCase()] = {
                name:      name,
                colour:    decodeColour(field(parts, fmt, 'primarycolour')),
                bold:      truthy(field(parts, fmt, 'bold')),
                italic:    truthy(field(parts, fmt, 'italic')),
                underline: truthy(field(parts, fmt, 'underline')),
                strikeout: truthy(field(parts, fmt, 'strikeout'))
            };
        }

        return {
            styles: byName,
            /* Style lookup is lenient: exact name, then Default, then a
             * blank style.  Dialogue lines referencing a style that isn't
             * in the table are common in hand-edited files. */
            get: function (name) {
                var key = String(name == null ? '' : name).trim().toLowerCase();
                return byName[key] || byName['default'] || null;
            },
            count: Object.keys(byName).length
        };
    }

    function field(parts, fmt, want) {
        var i = fmt.indexOf(want);
        return i >= 0 && i < parts.length ? parts[i] : null;
    }
    function truthy(v) {
        if (v == null) return false;
        var n = parseInt(String(v).trim(), 10);
        return !isNaN(n) && n !== 0;
    }

    /* ── Inline overrides → runs ──────────────────────────────────────────
     *
     * Walks the Text field, splitting it at {...} override blocks.  Literal
     * segments become runs carrying whatever appearance is in force; the
     * blocks mutate that appearance.  A block with no backslash is an ASS
     * comment and simply disappears, as do all the tags we don't draw.
     */
    function toRuns(rawText, style) {
        var base = {
            colour:    style && style.colour    ? style.colour    : null,
            bold:      !!(style && style.bold),
            italic:    !!(style && style.italic),
            underline: !!(style && style.underline),
            strikeout: !!(style && style.strikeout)
        };

        var text = String(rawText == null ? '' : rawText);
        var cur = copyState(base);
        var out = [];
        var drawing = 0;                 // \p1..\p4 — vector drawing, not text
        var i = 0;

        while (i < text.length) {
            var open = text.indexOf('{', i);

            if (open < 0) { push(out, text.slice(i), cur, drawing); break; }
            if (open > i)   push(out, text.slice(i, open), cur, drawing);

            var close = text.indexOf('}', open);
            if (close < 0) {
                /* Unmatched brace: libass renders the remainder literally
                 * rather than swallowing the rest of the line, so do that
                 * instead of dropping visible dialogue. */
                push(out, text.slice(open), cur, drawing);
                break;
            }

            drawing = applyTags(text.slice(open + 1, close), cur, base, style, drawing);
            i = close + 1;
        }

        return out;
    }

    function copyState(s) {
        return {
            colour:    s.colour,
            bold:      s.bold,
            italic:    s.italic,
            underline: s.underline,
            strikeout: s.strikeout
        };
    }

    /* \N is a hard break, \n a soft one (honoured here — the overlay is
     * `white-space: pre-line`), \h a non-breaking space. */
    function push(out, chunk, state, drawing) {
        if (drawing > 0) return;                    // drawing coords aren't text
        if (!chunk) return;

        var s = chunk
            .replace(/\\N/g, '\n')
            .replace(/\\n/g, '\n')
            .replace(/\\h/g, ' ')
            /* Stray HTML: ASS has no use for it, but hand-converted
             * files carry it and the old strip pipeline dropped it.  Keep
             * doing that, or "<i>" starts showing up on screen. */
            .replace(/<[^>]+>/g, '');
        if (!s) return;

        var last = out.length ? out[out.length - 1] : null;
        if (last && sameAppearance(last, state)) {
            last.text += s;                          // merge adjacent equal runs
            return;
        }
        out.push({
            text:      s,
            colour:    state.colour ? state.colour.css : null,
            bold:      state.bold,
            italic:    state.italic,
            underline: state.underline,
            strikeout: state.strikeout
        });
    }

    function sameAppearance(run, state) {
        return run.colour    === (state.colour ? state.colour.css : null) &&
               run.bold      === state.bold &&
               run.italic    === state.italic &&
               run.underline === state.underline &&
               run.strikeout === state.strikeout;
    }

    /* Tag dispatch.  Order matters: every check that could be a prefix of
     * another tag is tested longest-first, so \bord isn't read as \b,
     * \pos as \p, \clip as \c, \alpha as \a, or \shad as \s.  Colour and
     * alpha tags additionally require their &H… argument to be present,
     * which is what keeps \clip from ever reaching the \c branch.
     *
     * Returns the (possibly updated) drawing-mode depth.
     */
    function applyTags(block, cur, base, style, drawing) {
        if (block.indexOf('\\') < 0) return drawing;      // {comment} → drop

        var pieces = block.split('\\');
        for (var i = 1; i < pieces.length; i++) {         // [0] is pre-backslash text
            var p = pieces[i];
            if (!p) continue;

            var m;

            /* Primary colour: \c&H..& and \1c&H..& */
            if ((m = /^(?:1c|c)\s*(&h[0-9a-f]{1,8}&?)/i.exec(p))) {
                var col = decodeColour(m[1]);
                if (col) {
                    cur.colour = cur.colour
                        ? withAlpha(col, cur.colour.a < 1 ? cur.colour.a : col.a)
                        : col;
                }
                continue;
            }
            /* Primary alpha: \alpha&H..& and \1a&H..& */
            if ((m = /^(?:alpha|1a)\s*(&h[0-9a-f]{1,8}&?)/i.exec(p))) {
                var av = decodeColour(m[1]);
                if (av) {
                    /* \alpha carries one byte, so after zero-padding to
                     * AABBGGRR it lands in the *red* slot — not the alpha
                     * slot.  Read transparency from there. */
                    cur.colour = withAlpha(cur.colour || { r: 255, g: 255, b: 255 },
                                           1 - (av.r / 255));
                }
                continue;
            }
            /* Secondary / outline / shadow colour + alpha — not drawn. */
            if (/^[234](?:c|a)\s*&h/i.test(p)) continue;

            /* Bold — after \bord, \blur, \be */
            if (/^b(?:ord|lur|e)/i.test(p)) continue;
            if ((m = /^b(-?\d+)?$/i.exec(p))) {
                cur.bold = m[1] == null ? base.bold : weightIsBold(m[1]);
                continue;
            }

            /* Italic — after \iclip */
            if (/^iclip/i.test(p)) continue;
            if ((m = /^i(-?\d+)?$/i.exec(p))) {
                cur.italic = m[1] == null ? base.italic : parseInt(m[1], 10) !== 0;
                continue;
            }

            /* Underline */
            if ((m = /^u(-?\d+)?$/i.exec(p))) {
                cur.underline = m[1] == null ? base.underline : parseInt(m[1], 10) !== 0;
                continue;
            }

            /* Strikeout — after \shad */
            if (/^shad/i.test(p)) continue;
            if ((m = /^s(-?\d+)?$/i.exec(p))) {
                cur.strikeout = m[1] == null ? base.strikeout : parseInt(m[1], 10) !== 0;
                continue;
            }

            /* Vector drawing mode — after \pos, \pbo.  \p1+ means the
             * following literal text is drawing commands (m 0 0 l 100 …),
             * which must not be painted as dialogue; \p0 ends it. */
            if (/^p(?:os|bo)/i.test(p)) continue;
            if ((m = /^p(\d+)$/i.exec(p))) {
                drawing = parseInt(m[1], 10) || 0;
                continue;
            }

            /* Reset: \r to the dialogue's own style, \rName to another. */
            if (/^rnd/i.test(p)) continue;
            if ((m = /^r(.*)$/i.exec(p))) {
                var target = m[1] ? String(m[1]).trim() : '';
                var next = base;
                if (target && style && style._table) {
                    var found = style._table.get(target);
                    if (found) next = found;
                }
                cur.colour    = next.colour || null;
                cur.bold      = !!next.bold;
                cur.italic    = !!next.italic;
                cur.underline = !!next.underline;
                cur.strikeout = !!next.strikeout;
                continue;
            }

            /* \pos \move \an \a \fs \fn \fr \t \k \fad \clip \q \fsp … —
             * recognised by omission, dropped without leaking arguments. */
        }
        return drawing;
    }

    /* \b1 = bold, \b0 = normal, \b100..\b900 = weight (600+ reads bold). */
    function weightIsBold(raw) {
        var n = parseInt(raw, 10);
        if (isNaN(n) || n === 0) return false;
        if (n >= 100) return n >= 600;
        return true;
    }

    /* Plain text of a run list — what the old strip pipeline produced, kept
     * for SRT export, cue-matching debug output and the unstyled fast path. */
    function plainText(runs) {
        if (!runs || !runs.length) return '';
        var s = '';
        for (var i = 0; i < runs.length; i++) s += runs[i].text;
        return s.trim();
    }

    /* True when nothing in the run list needs a <span> — lets callers drop
     * the runs entirely and keep the cheaper textContent paint path, so
     * subtitles with no styling render exactly as they did before. */
    function isPlain(runs) {
        if (!runs || !runs.length) return true;
        for (var i = 0; i < runs.length; i++) {
            var r = runs[i];
            if (r.colour || r.bold || r.italic || r.underline || r.strikeout) return false;
        }
        return true;
    }

    /* Convenience for callers holding a whole .ass file: parse the style
     * table once, then convert Dialogue Text fields against it. */
    function forFile(assText) {
        var table = parseStyles(assText);
        return {
            table: table,
            runs: function (rawText, styleName) {
                var st = table.get(styleName);
                if (st) st._table = table;            // enables \rOtherStyle
                return toRuns(rawText, st);
            }
        };
    }

    return {
        parseStyles:   parseStyles,
        toRuns:        toRuns,
        plainText:     plainText,
        isPlain:       isPlain,
        forFile:       forFile,
        decodeColour:  decodeColour
    };
})();

// Ignored by the Tizen/browser build; lets Node tests require the parser.
if (typeof module !== 'undefined' && module.exports) module.exports = AssStyle;

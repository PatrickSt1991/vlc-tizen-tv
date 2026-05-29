/* USB / local file browsing via tizen.filesystem.
 *
 * Tizen Web FS uses a "virtual root" concept:
 *   - 'removable1', 'removable2' etc. for USB drives
 *   - 'documents', 'downloads', 'music', 'videos', 'images' for built-in
 *   - 'wgt-package' for our app's own bundled files
 *
 * We resolve all known roots, list any that contain media, and let the user
 * navigate file tree relative to them.  Files matching media extensions
 * become "playable" items. */

var Browser = (function () {
    var MEDIA_EXTS = [
        // Video
        'mp4','m4v','mkv','avi','mov','wmv','webm','flv','ts','m2ts','mpg','mpeg','3gp',
        // Audio
        'mp3','aac','flac','wav','ogg','m4a','wma','opus',
        // Playlists / streams
        'm3u','m3u8','mpd','pls'
    ];
    // Text-based subtitle formats we can convert to WebVTT on the fly.
    // Image-based subs (.sub/.idx VobSub, .sup PGS, DVD streams) aren't
    // representable in HTML5 <track> at all and are deliberately omitted.
    var SUBTITLE_EXTS = ['vtt', 'srt', 'ass', 'ssa', 'smi', 'sami'];

    function ext(name) {
        var dot = name.lastIndexOf('.');
        return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
    }
    function basename(name) {
        var dot = name.lastIndexOf('.');
        return dot < 0 ? name : name.slice(0, dot);
    }
    function isMedia(name)    { return MEDIA_EXTS.indexOf(ext(name)) >= 0; }
    function isSubtitle(name) { return SUBTITLE_EXTS.indexOf(ext(name)) >= 0; }

    /* Static fallback list of known Tizen virtual root names — used only when
     * tizen.filesystem.listStorages() isn't available (very old firmware). */
    var STATIC_ROOTS = [
        'removable1', 'removable2', 'removable3', 'removable4',
        'downloads', 'videos', 'music', 'images', 'documents'
    ];

    /* List the top-level "drives" — only includes ones that resolve.
     *
     * The right way on modern Tizen is `tizen.filesystem.listStorages()` —
     * USB drives appear in there with dynamic names like `removable_<uuid>`
     * which a static hardcoded list can never match.  We pull from that
     * dynamic list when available, and only fall back to the static one if
     * the API throws or returns empty (e.g. very old firmware). */
    function listRoots(cb) {
        if (typeof tizen === 'undefined' || !tizen.filesystem) {
            if (typeof Debug !== 'undefined') Debug.browse('tizen.filesystem not available');
            cb(new Error('tizen.filesystem not available')); return;
        }

        var dynamicNames = null;

        function resolveAll(names, done) {
            var results = [];
            if (!names.length) { done(results); return; }
            var pending = names.length;
            names.forEach(function (name) {
                try {
                    tizen.filesystem.resolve(name,
                        function (dir) {
                            if (typeof Debug !== 'undefined') Debug.browse('  resolved ' + name + ' → ' + dir.fullPath);
                            results.push({ name: name, dir: dir, fullPath: dir.fullPath });
                            if (--pending === 0) done(results);
                        },
                        function (err) {
                            if (typeof Debug !== 'undefined') Debug.browse('  ' + name + ' rejected: ' + (err && err.message || err));
                            if (--pending === 0) done(results);
                        },
                        'r'
                    );
                } catch (e) {
                    if (typeof Debug !== 'undefined') Debug.browse('  ' + name + ' threw: ' + e.message);
                    if (--pending === 0) done(results);
                }
            });
        }

        function finalize(results) {
            // Sort: external/removable first, then internal
            results.sort(function (a, b) {
                var ar = /removable|usb/i.test(a.name) ? 0 : 1;
                var br = /removable|usb/i.test(b.name) ? 0 : 1;
                if (ar !== br) return ar - br;
                return a.name.localeCompare(b.name);
            });
            if (typeof Debug !== 'undefined') Debug.browse('listRoots done: ' + results.length + ' usable');
            cb(null, results);
        }

        /* 1. Try the modern enumeration API first. */
        try {
            tizen.filesystem.listStorages(function (storages) {
                if (typeof Debug !== 'undefined')
                    Debug.browse('listStorages → ' + storages.length + ' entries: ' +
                        storages.map(function (s) { return s.label + '(' + s.type + '/' + s.state + ')'; }).join(', '));
                // Use mounted storages — both INTERNAL and EXTERNAL
                dynamicNames = storages
                    .filter(function (s) { return s.state === 'MOUNTED'; })
                    .map(function (s) { return s.label; });
                if (dynamicNames.length === 0) {
                    if (typeof Debug !== 'undefined') Debug.browse('listStorages empty — falling back to static probe');
                    resolveAll(STATIC_ROOTS, finalize);
                } else {
                    // Also try standard convenience names that listStorages might miss
                    var extras = ['videos', 'downloads', 'music', 'images', 'documents'];
                    var combined = dynamicNames.slice();
                    extras.forEach(function (n) { if (combined.indexOf(n) < 0) combined.push(n); });
                    resolveAll(combined, finalize);
                }
            }, function (err) {
                if (typeof Debug !== 'undefined') Debug.browse('listStorages err: ' + (err && err.message || err));
                resolveAll(STATIC_ROOTS, finalize);
            });
        } catch (e) {
            if (typeof Debug !== 'undefined') Debug.browse('listStorages threw: ' + e.message + ' — falling back');
            resolveAll(STATIC_ROOTS, finalize);
        }
    }

    /* List entries of a given Tizen File (must be a directory). */
    function listDir(file, cb) {
        if (typeof Debug !== 'undefined') Debug.browse('listDir ' + (file && file.fullPath));
        try {
            file.listFiles(
                function (entries) {
                    if (typeof Debug !== 'undefined') Debug.browse('  ' + entries.length + ' entries');

                    // Build a map of basename → list of sibling subtitle files
                    // so each playable item knows its candidate subtitles.
                    var subsByBase = {};
                    entries.forEach(function (f) {
                        if (!f.isDirectory && isSubtitle(f.name)) {
                            var base = basename(f.name).toLowerCase();
                            (subsByBase[base] = subsByBase[base] || []).push({
                                name:     f.name,
                                lang:     extractLangTag(f.name),
                                ext:      ext(f.name),
                                uri:      typeof f.toURI === 'function' ? f.toURI() : 'file://' + f.fullPath,
                                fullPath: f.fullPath,
                                file:     f
                            });
                        }
                    });

                    var out = entries.map(function (f) {
                        var subs = [];
                        if (!f.isDirectory && isMedia(f.name)) {
                            // Sibling subtitles: same basename (case-insensitive)
                            var base = basename(f.name).toLowerCase();
                            subs = subsByBase[base] || [];
                            // Also include subtitles whose basename starts with
                            // the video's basename (e.g. movie.en.srt next to movie.mp4)
                            Object.keys(subsByBase).forEach(function (k) {
                                if (k !== base && k.indexOf(base + '.') === 0) {
                                    subsByBase[k].forEach(function (s) {
                                        if (subs.indexOf(s) < 0) subs.push(s);
                                    });
                                }
                            });
                        }
                        return {
                            name:     f.name,
                            isDir:    f.isDirectory,
                            playable: !f.isDirectory && isMedia(f.name),
                            size:     f.fileSize,
                            mtime:    f.modified,
                            file:     f,
                            uri:      avplayURI(f),
                            fullPath: f.fullPath,
                            subtitles: subs
                        };
                    });
                    out.sort(function (a, b) {
                        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
                        return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
                    });
                    cb(null, out);
                },
                function (err) {
                    if (typeof Debug !== 'undefined') Debug.browse('  listFiles err: ' + (err && err.message || err));
                    cb(err);
                }
            );
        } catch (e) {
            if (typeof Debug !== 'undefined') Debug.browse('  listDir threw: ' + e.message);
            cb(e);
        }
    }

    /* Return parent of a Tizen File via its parent property, or null at root. */
    function parentOf(file) {
        return file && file.parent ? file.parent : null;
    }

    /* Build the URI to hand to the player for a local File.  We use tizen's
     * own toURI() — file:///opt/media/USBDriveXX/... — which the WebView's
     * HTML5 <video> element can load (AVPlay can't on this firmware). */
    function avplayURI(f) {
        if (typeof f.toURI === 'function') return f.toURI();
        return 'file://' + (f.fullPath || '');
    }

    /* Convert a fileSize to "1.2 GB" style. */
    function humanSize(bytes) {
        if (typeof bytes !== 'number') return '';
        var units = ['B','KB','MB','GB','TB'], i = 0;
        while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
        return bytes.toFixed(bytes >= 10 || i === 0 ? 0 : 1) + ' ' + units[i];
    }

    /* Extract a 2-3 letter ISO language code from a subtitle file's name,
     * e.g. "movie.en.srt" → "en", "movie.eng.vtt" → "eng".  Returns '' if
     * no language tag can be inferred. */
    function extractLangTag(name) {
        var b = basename(name);                  // "movie.en"
        var parts = b.split('.');
        if (parts.length < 2) return '';
        var last = parts[parts.length - 1];
        if (/^[a-z]{2,3}$/i.test(last)) return last.toLowerCase();
        return '';
    }

    /* Read a subtitle file's content as UTF-8 text via tizen.filesystem. */
    function readSubtitleText(subEntry, cb) {
        if (!subEntry || !subEntry.file) { cb(new Error('no file')); return; }
        try {
            subEntry.file.openStream('r',
                function (stream) {
                    try {
                        var text = stream.read(stream.bytesAvailable);
                        stream.close();
                        cb(null, text);
                    } catch (e) {
                        try { stream.close(); } catch (e2) {}
                        cb(e);
                    }
                },
                function (err) { cb(err); },
                'UTF-8'
            );
        } catch (e) {
            cb(e);
        }
    }

    return {
        listRoots:        listRoots,
        listDir:          listDir,
        parentOf:         parentOf,
        isMedia:          isMedia,
        isSubtitle:       isSubtitle,
        humanSize:        humanSize,
        readSubtitleText: readSubtitleText
    };
})();

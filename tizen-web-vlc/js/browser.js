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
    function isMedia(name) {
        var dot = name.lastIndexOf('.');
        if (dot < 0) return false;
        return MEDIA_EXTS.indexOf(name.slice(dot + 1).toLowerCase()) >= 0;
    }

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
                    var out = entries.map(function (f) {
                        return {
                            name:     f.name,
                            isDir:    f.isDirectory,
                            playable: !f.isDirectory && isMedia(f.name),
                            size:     f.fileSize,
                            mtime:    f.modified,
                            file:     f,
                            uri:      avplayURI(f),
                            fullPath: f.fullPath
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

    /* Build the URI to hand to AVPlay for a local File.
     * Use Tizen's own toURI() which returns the correct file:// URL for the
     * mounted path — anything else risks SMACK label / path mismatches. */
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

    return {
        listRoots: listRoots,
        listDir:   listDir,
        parentOf:  parentOf,
        isMedia:   isMedia,
        humanSize: humanSize
    };
})();

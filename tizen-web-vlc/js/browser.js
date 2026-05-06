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

    /* All Tizen FS virtual roots we want to surface. */
    var ROOTS = [
        'removable1', 'removable2', 'removable3',
        'downloads', 'videos', 'music', 'images', 'documents'
    ];

    /* List the top-level "drives" — only includes ones that resolve. */
    function listRoots(cb) {
        if (typeof tizen === 'undefined' || !tizen.filesystem) {
            if (typeof Debug !== 'undefined') Debug.browse('tizen.filesystem not available');
            cb(new Error('tizen.filesystem not available')); return;
        }
        if (typeof Debug !== 'undefined') Debug.browse('listRoots: probing ' + ROOTS.join(','));
        var results = [];
        var pending = ROOTS.length;
        ROOTS.forEach(function (name) {
            try {
                tizen.filesystem.resolve(name,
                    function (dir) {
                        if (typeof Debug !== 'undefined') Debug.browse('  resolved ' + name + ' → ' + dir.fullPath);
                        results.push({ name: name, dir: dir, fullPath: dir.fullPath });
                        if (--pending === 0) {
                            if (typeof Debug !== 'undefined') Debug.browse('listRoots done: ' + results.length + ' usable');
                            cb(null, results);
                        }
                    },
                    function (err) {
                        if (typeof Debug !== 'undefined') Debug.browse('  ' + name + ' rejected: ' + (err && err.message || err));
                        if (--pending === 0) cb(null, results);
                    },
                    'r'
                );
            } catch (e) {
                if (typeof Debug !== 'undefined') Debug.browse('  ' + name + ' threw: ' + e.message);
                if (--pending === 0) cb(null, results);
            }
        });
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
                            // Path the AVPlay native shim recognises for local
                            // files — the toURI() form is the safest.
                            uri:      typeof f.toURI === 'function' ? f.toURI() : 'file://' + f.fullPath,
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

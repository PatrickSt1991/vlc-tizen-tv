/* Focus management + view switching + toast.
 *
 * Focus model: every "focusable" widget has tabindex (or is a <button>/<input>);
 * we manage focus manually because TV WebKit's default focus + arrow-key nav is
 * unreliable.  Each view declares its focus order via DOM order of elements
 * matching the per-view selector. */

var UI = (function () {
    var currentView = null;
    var focusable = [];
    var focusIdx  = 0;

    var FOCUSABLE_SELECTOR =
        'button, input, [tabindex="0"], .tile, .ctrl, .preset, ' +
        '.browse-list li, .track-section li:not(.muted)';

    function showView(id) {
        var views = document.querySelectorAll('.view');
        for (var i = 0; i < views.length; i++) views[i].classList.add('hidden');
        var v = document.getElementById(id);
        if (!v) return;
        v.classList.remove('hidden');
        currentView = v;
        refreshFocusables();
        var initial = v.querySelector('[data-focus]') || focusable[0];
        focusOn(initial);
    }

    function refreshFocusables() {
        /* Scope focusables to whichever modal/overlay is currently visible,
         * falling back to currentView for the normal case.  Without this the
         * picker (#picker) and other body-level overlays would never appear
         * in the focusable list because currentView.querySelectorAll can't
         * reach them. */
        var picker    = document.getElementById('picker');
        var trackMenu = document.getElementById('track-menu');
        var errorOv   = document.getElementById('error-overlay');

        var scope = currentView;
        if (picker    && !picker.classList.contains('hidden'))    scope = picker;
        else if (errorOv   && !errorOv.classList.contains('hidden')) scope = errorOv;
        else if (trackMenu && !trackMenu.classList.contains('hidden')) scope = trackMenu;

        focusable = scope
            ? Array.prototype.slice.call(scope.querySelectorAll(FOCUSABLE_SELECTOR))
            : [];
        focusable = focusable.filter(function (el) {
            return !el.classList.contains('hidden') && el.offsetParent !== null;
        });
    }

    function focusOn(el) {
        if (!el) return;
        // Clear .focused from everywhere, not just current focusables, so the
        // class doesn't leak across overlays.
        var prev = document.querySelectorAll('.focused');
        for (var p = 0; p < prev.length; p++) prev[p].classList.remove('focused');

        el.classList.add('focused');
        el.focus({ preventScroll: false });
        focusIdx = focusable.indexOf(el);
        if (focusIdx < 0) focusIdx = 0;

        // Generic "scroll into view" so settings rows / picker items / browse
        // list entries / etc. always stay visible when navigated to.
        try { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) {}
    }

    /* Geometric next-element search by direction.  Falls back to the next/prev
     * element in DOM order if nothing matches geometrically. */
    function moveFocus(dir) {
        refreshFocusables();
        if (!focusable.length) return;
        var current = focusable[focusIdx] || focusable[0];
        var cr = current.getBoundingClientRect();
        var ccx = cr.left + cr.width / 2, ccy = cr.top + cr.height / 2;

        var best = null, bestDist = Infinity;
        for (var i = 0; i < focusable.length; i++) {
            var el = focusable[i]; if (el === current) continue;
            var r = el.getBoundingClientRect();
            var rcx = r.left + r.width / 2, rcy = r.top + r.height / 2;
            var dx = rcx - ccx, dy = rcy - ccy;
            var ok = (
                (dir === 'up'    && dy < -10) ||
                (dir === 'down'  && dy >  10) ||
                (dir === 'left'  && dx < -10) ||
                (dir === 'right' && dx >  10)
            );
            if (!ok) continue;
            // Distance with a perpendicular penalty so we prefer items roughly
            // aligned along the axis of motion.
            var dist;
            if (dir === 'up' || dir === 'down')
                dist = Math.abs(dy) + Math.abs(dx) * 2;
            else
                dist = Math.abs(dx) + Math.abs(dy) * 2;
            if (dist < bestDist) { bestDist = dist; best = el; }
        }

        if (best) focusOn(best);
        else if (dir === 'down' || dir === 'right')
            focusOn(focusable[(focusIdx + 1) % focusable.length]);
        else
            focusOn(focusable[(focusIdx - 1 + focusable.length) % focusable.length]);
    }

    function activateFocused() {
        /* Look anywhere — picker / track menu / error overlay live outside
         * the current view but still own focus when visible. */
        var el = document.querySelector('.focused');
        if (!el) return false;
        if (el.tagName === 'INPUT') return false;
        el.click();
        return true;
    }

    /* Move focus to the previous/next focusable in DOM order, cycling.
     * Used by the player OSD: Up/Down should walk through the row of round
     * controls regardless of geometry (they're side-by-side, so moveFocus()'s
     * directional search wouldn't find them on Up/Down). */
    function moveFocusCyclic(delta) {
        refreshFocusables();
        if (!focusable.length) return;
        var current = document.querySelector('.focused') ||
                      focusable[focusIdx] || focusable[0];
        var i = focusable.indexOf(current);
        if (i < 0) i = 0;
        var next = focusable[(i + delta + focusable.length) % focusable.length];
        focusOn(next);
    }

    /* Toast: brief on-screen message. */
    var toastTimer = null;
    function toast(msg) {
        var t = document.getElementById('toast');
        t.textContent = msg;
        t.classList.remove('hidden');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { t.classList.add('hidden'); }, 2000);
    }

    return {
        showView:          showView,
        focusOn:           focusOn,
        moveFocus:         moveFocus,
        moveFocusCyclic:   moveFocusCyclic,
        activateFocused:   activateFocused,
        refreshFocusables: refreshFocusables,
        toast:             toast,
        get currentView() { return currentView; }
    };
})();

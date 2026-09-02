'use strict';

var assert = require('assert');
var test = require('node:test');
var Settings = require('../../tizen-web-vlc/js/settings.js');
var LanguageList = Settings.LanguageList;
var AspectRatio  = Settings.AspectRatio;

function codes(list) { return list.map(function (l) { return l.code; }); }

/* ── The picker lists ─────────────────────────────────────────────────── */

test('Vietnamese is offered for both audio and subtitles', function () {
    assert.ok(codes(LanguageList.forAudio()).indexOf('vi') >= 0);
    assert.ok(codes(LanguageList.forSubtitle()).indexOf('vi') >= 0);
    assert.strictEqual(LanguageList.nameFor('vi'), 'Tiếng Việt');
});

test('the subtitle list keeps Off in front of the languages', function () {
    assert.strictEqual(LanguageList.forSubtitle()[0].code, 'off');
    assert.strictEqual(LanguageList.nameFor('off'), 'Off');
});

/* ── matchScore ───────────────────────────────────────────────────────── */

test('a language tag wins outright, in either ISO spelling', function () {
    assert.strictEqual(LanguageList.matchScore('vi', 'vie', 'Subtitle 3'), 100);
    assert.strictEqual(LanguageList.matchScore('vi', 'vi',  'Subtitle 3'), 100);
    assert.strictEqual(LanguageList.matchScore('vi', 'vi-VN', 'Subtitle 3'), 100);
    assert.strictEqual(LanguageList.matchScore('de', 'ger', 'Track 2'), 100);
    assert.strictEqual(LanguageList.matchScore('nl', 'dut', 'Track 2'), 100);
});

test('untagged tracks match on the spelled-out name', function () {
    assert.ok(LanguageList.matchScore('vi', '', 'Vietnamese (SDH)') > 0);
    assert.ok(LanguageList.matchScore('vi', '', 'Tiếng Việt') > 0);
    assert.ok(LanguageList.matchScore('zh', '', '简体中文') > 0);
    assert.ok(LanguageList.matchScore('ko', '', 'Korean forced') > 0);
});

test('a bracketed code counts, and beats a bare word match', function () {
    var bracketed = LanguageList.matchScore('fr', '', 'Subtitle [fre]');
    var word      = LanguageList.matchScore('fr', '', 'French subtitles');
    assert.ok(bracketed > 0 && word > 0);
    assert.ok(bracketed > word);
});

test('a two-letter code matches only as its own word', function () {
    // The bug this guards: "Movie.2019.1080p" is not a Vietnamese track.
    assert.strictEqual(LanguageList.matchScore('vi', '', 'Movie.2019.1080p'), 0);
    assert.ok(LanguageList.matchScore('vi', '', 'Show.S01E02.vi.srt') > 0);
});

test('a mismatched language scores nothing', function () {
    assert.strictEqual(LanguageList.matchScore('vi', 'eng', 'English'), 0);
    assert.strictEqual(LanguageList.matchScore('en', 'vie', 'Tiếng Việt'), 0);
});

test('no preference and Off never match a track', function () {
    assert.strictEqual(LanguageList.matchScore('',    'vie', 'Vietnamese'), 0);
    assert.strictEqual(LanguageList.matchScore('off', 'vie', 'Vietnamese'), 0);
});

/* ── Aspect modes ─────────────────────────────────────────────────────── */

test('fit is the default aspect mode and keeps the letterbox', function () {
    var fit = AspectRatio.find('fit');
    assert.strictEqual(AspectRatio.forList()[0].code, 'fit');
    assert.strictEqual(fit.av, 'PLAYER_DISPLAY_MODE_LETTER_BOX');
    assert.strictEqual(fit.fit, 'contain');
    assert.strictEqual(fit.zoom, 1);
});

test('fill crops instead of distorting, stretch distorts', function () {
    assert.strictEqual(AspectRatio.find('fill').av, 'PLAYER_DISPLAY_MODE_CROPPED_FULL');
    assert.strictEqual(AspectRatio.find('fill').fit, 'cover');
    assert.strictEqual(AspectRatio.find('stretch').av, 'PLAYER_DISPLAY_MODE_FULL_SCREEN');
    assert.strictEqual(AspectRatio.find('stretch').fit, 'fill');
});

test('the zoom modes scale past the frame edge', function () {
    assert.ok(AspectRatio.find('zoom110').zoom > 1);
    assert.ok(AspectRatio.find('zoom125').zoom > AspectRatio.find('zoom110').zoom);
});

test('the crop modes derive their zoom from the frame they are given', function () {
    var SIXTEEN_NINE = 3840 / 2160;

    // The case that prompted this: 2.39:1 content letterboxed into a 4K 16:9
    // frame.  Measured on the file, the bars are 275 px top and 276 bottom of
    // 2160, leaving 1609 px of picture — so 2160/1609 = 1.342x clears them.
    var z = AspectRatio.zoomFor('crop239', SIXTEEN_NINE);
    assert.ok(Math.abs(z - 2160 / 1609) < 0.01,
        'expected ~1.34x to crop 2.39:1 out of 16:9, got ' + z);
    // Neither fixed step lands there: 125% leaves a bar, and nothing offered
    // 134% before.
    assert.ok(z > AspectRatio.find('zoom125').zoom);

    // 2:1 content in the same frame needs much less.
    assert.ok(Math.abs(AspectRatio.zoomFor('crop20', SIXTEEN_NINE) - 1.125) < 0.001);

    // A frame already that wide has no bars to crop, so it is left alone.
    assert.strictEqual(AspectRatio.zoomFor('crop239', 2.39), 1);
    assert.strictEqual(AspectRatio.zoomFor('crop20', 2.39), 1);
    assert.strictEqual(AspectRatio.zoomFor('crop239', 2.5), 1);

    // Nonsense frame data must not blank the screen.
    assert.strictEqual(AspectRatio.zoomFor('crop239', 0), 1);
    assert.strictEqual(AspectRatio.zoomFor('crop239', -1), 1);
    // An absurdly tall frame is clamped rather than magnified without limit.
    assert.strictEqual(AspectRatio.zoomFor('crop239', 0.1), 2);
});

test('zoomFor leaves the fixed and non-zooming modes as they are', function () {
    assert.strictEqual(AspectRatio.zoomFor('fit', 16 / 9), 1);
    assert.strictEqual(AspectRatio.zoomFor('fill', 16 / 9), 1);
    assert.strictEqual(AspectRatio.zoomFor('stretch', 16 / 9), 1);
    // Fixed steps ignore the frame entirely.
    assert.strictEqual(AspectRatio.zoomFor('zoom110', 16 / 9), 1.10);
    assert.strictEqual(AspectRatio.zoomFor('zoom125', 2.39), 1.25);
});

test('an unknown mode falls back to fit, and next() cycles', function () {
    assert.strictEqual(AspectRatio.find('nonsense').code, 'fit');
    var seen = {}, code = 'fit';
    for (var i = 0; i < AspectRatio.forList().length; i++) {
        assert.ok(!seen[code], 'cycle repeats before visiting every mode');
        seen[code] = true;
        code = AspectRatio.next(code);
    }
    assert.strictEqual(code, 'fit', 'cycle returns to the start');
    // Every mode carries an OSD label short enough for the round button.
    AspectRatio.forList().forEach(function (m) {
        assert.ok(m.short.length <= 4, m.code + ' label too long: ' + m.short);
    });
});

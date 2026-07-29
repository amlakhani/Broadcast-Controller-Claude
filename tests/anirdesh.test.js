import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAnirdeshText, findRepeatStart, isJunkLine, isFooterStart } from '../frontend/src/utils/anirdesh.js';

// Faithful reproduction of a live anirdesh kirtan page's extracted text
// (https://www.anirdesh.com/kirtan/index.php?lang=1&part=1&no=1), including the
// accented block, the plain-ASCII repeat, and the full footer/nav chrome.
const REAL_PAGE = `1-1: માધોજી મેરે તુમ હી એક -  Anirdesh Kirtan Muktavali
menu
search
dark_mode
share
tune
Language
ગુ
En
Show Lyrics
Font Size
text_decrease
text_increase
close
Search
What:
Title
Lyrics
Type:
Keyword
Exact
close
Favorites
All Categories
All Writers
Add kirtans to your favorites list. Your favorites are saved locally on this device.
close
History
Your view history is currently blank.
close
Study
કીર્તન મુક્તાવલી
માધોજી મેરે તુમ હી એક
૧-૧: સદ્‍ગુરુ પ્રેમાનંદ સ્વામી
Category: પ્રાર્થના
રાગ: ભૈરવી
માધોજી મેરે તુમ હી એક,
પાંઉ ધરનકો ઠેકાનો... ꠶ટેક
શુભ ગતિ અશુભ ગતિ તુમ હી મેરે તો,
હાથ તિહારે બેચાનો... માધો꠶ ૧
તુમ બિના સુખ નાહીં ત્રિભુવનમેં મોયે,
બહુત ફિર્યો હું ભુલાનો... માધો꠶ ૨
પર્યો આય દ્વારે દીન પ્રેમાનંદ ગુનહીન,
કિંકર રાવરો જાનો... માધો꠶ ૩
Mādhojī mere tum hī ek
1-1: Sadguru Premanand Swami
Category: Prarthana
Raag(s): Bhairavi
Mādhojī mere tum hī ek, pāu dharanko ṭhekāno...
Shubh gati ashubh gati tum hī mere to,
hāth tihāre bechāno... Mādho 1
Tum binā sukh nāhī Tribhuvanme moye,
bahut firyo hu bhūlāno... Mādho 2
Paryo āy dvāre dīn Premānand gunhīn,
kinkar rāvaro jāno... Mādho 3
Madhoji mere tum hi ek
Madhoji mere tum hi ek, pau dharanko thekano...
Shubh gati ashubh gati tum hi mere to,
hath tihare bechano... Madho 1
Tum bina sukh nahi Tribhuvanme moye,
bahut firyo hu bhulano... Madho 2
Paryo ay dvare din Premanand gunhin,
kinkar ravaro jano... Madho 3
Kirtan Selection
close
sort
Go to:
chevron_right
Sort by:
Alphabetical
Kirtan number
Hindi
Title
Category
Utsavs
Writer
Media
Artist
Raag
Multi Pads
< 4 pads
4 pads
> 4 pads
Kirtan Study
Quick Links
Cheshta with Meaning
Vachanamrut
Swamini Vato
Nishkulanand Kavya
Harililamrut
Aksharamrutam
Bhaktachintamani
Bhagwad Gita
Bhagvat Purana
Feedback
Anirdesh.com ©2012
close`;

test('parses the accented verse only — no plain-ASCII repeat, no footer', () => {
    const { EN } = parseAnirdeshText(REAL_PAGE);

    assert.deepEqual(EN, [
        'Mādhojī mere tum hī ek, pāu dharanko ṭhekāno...',
        'Shubh gati ashubh gati tum hī mere to,',
        'hāth tihāre bechāno... Mādho',
        'Tum binā sukh nāhī Tribhuvanme moye,',
        'bahut firyo hu bhūlāno... Mādho',
        'Paryo āy dvāre dīn Premānand gunhīn,',
        'kinkar rāvaro jāno... Mādho',
    ]);
});

test('the plain-ASCII duplicate of the song is gone', () => {
    const { EN } = parseAnirdeshText(REAL_PAGE);
    const joined = EN.join('\n');
    // The repeat block's unaccented spellings must not survive.
    assert.ok(!joined.includes('Madhoji mere tum hi ek'), 'unaccented title repeat leaked through');
    assert.ok(!joined.includes('pau dharanko thekano'), 'unaccented body repeat leaked through');
    // Every kept line should still carry its diacritics.
    assert.ok(EN.some(l => /[āīūṭḍṇṣśḥṃḷ]/.test(l)), 'expected the accented block to be the one kept');
});

test('no footer, nav, or icon-ligature text survives', () => {
    const { EN, GU } = parseAnirdeshText(REAL_PAGE);
    const all = [...EN, ...GU].join('\n');
    for (const junk of [
        'close', 'sort', 'chevron_right', 'Go to:', 'Sort by:', '4 pads',
        'Cheshta with Meaning', 'Vachanamrut', 'Swamini Vato', 'Nishkulanand Kavya',
        'Harililamrut', 'Aksharamrutam', 'Bhaktachintamani', 'Bhagwad Gita',
        'Bhagvat Purana', 'Feedback', 'Anirdesh.com', 'Kirtan Selection', 'Quick Links',
    ]) {
        assert.ok(!all.includes(junk), `footer junk leaked: "${junk}"`);
    }
});

test('Gujarati verses are still parsed, without the attribution or raag lines', () => {
    const { GU } = parseAnirdeshText(REAL_PAGE);
    assert.ok(GU.length >= 6, `expected the Gujarati verse lines, got ${GU.length}`);
    assert.ok(GU[0].includes('માધોજી મેરે તુમ હી એક'));
    assert.ok(!GU.some(l => l.startsWith('રાગ')), 'raag line should be dropped');
    assert.ok(!GU.some(l => /^૧-૧:/.test(l)), 'attribution line should be dropped');
});

test('findRepeatStart matches a bare-title repeat against a longer first line', () => {
    // This is the case the old exact/word-match logic could not bridge.
    const lines = [
        'Mādhojī mere tum hī ek, pāu dharanko ṭhekāno...',
        'Shubh gati ashubh gati tum hī mere to,',
        'hāth tihāre bechāno... Mādho',
        'Tum binā sukh nāhī Tribhuvanme moye,',
        'Madhoji mere tum hi ek',
        'Madhoji mere tum hi ek, pau dharanko thekano...',
        'Shubh gati ashubh gati tum hi mere to,',
    ];
    assert.equal(findRepeatStart(lines), 4);
});

test('findRepeatStart matches an exact repeat too', () => {
    const lines = [
        'Lagnī lāgī re māre lagnī lāgī,',
        'Sakhī Shāmaḷīyā sangāthe māre lagnī lāgī...',
        'Miṭhe svare Mohanjīnī moralī vāgī,',
        'Sāmbhaḷtāmā chatkī lāgī jhabkī jāgī',
        'Lagni lagi re mare lagni lagi',
        'Mithe svare Mohanjini morali vagi,',
        'Sambhaltama chatki lagi jhabki jagi',
    ];
    assert.equal(findRepeatStart(lines), 4);
});

test('findRepeatStart leaves a song with no repeat untouched', () => {
    const lines = [
        'Mādhojī mere tum hī ek, pāu dharanko ṭhekāno...',
        'Shubh gati ashubh gati tum hī mere to,',
        'hāth tihāre bechāno... Mādho',
        'Tum binā sukh nāhī Tribhuvanme moye,',
    ];
    assert.equal(findRepeatStart(lines), 4);
});

test('a repeated refrain does not truncate an all-plain song', () => {
    // No diacritics anywhere, so only a back-half exact repeat may cut.
    const lines = [
        'Jay jay Swaminarayan',
        'Line two here',
        'Jay jay Swaminarayan',   // refrain near the top — must NOT cut
        'Line four here',
        'Line five here',
        'Line six here',
    ];
    assert.equal(findRepeatStart(lines), 6);
});

test('junk and footer helpers behave', () => {
    assert.equal(isFooterStart('Kirtan Selection'), true);
    assert.equal(isFooterStart('  quick links  '), true);
    assert.equal(isFooterStart('Mādhojī mere tum hī ek'), false);

    assert.equal(isJunkLine('close'), true);
    assert.equal(isJunkLine('chevron_right'), true);
    assert.equal(isJunkLine('< 4 pads'), true);
    assert.equal(isJunkLine('Anirdesh.com ©2012'), true);
    assert.equal(isJunkLine('1-1: Sadguru Premanand Swami'), true);
    assert.equal(isJunkLine('Raag(s): Bhairavi'), true);
    assert.equal(isJunkLine('Mādhojī mere tum hī ek, pāu dharanko ṭhekāno...'), false);
    assert.equal(isJunkLine('માધોજી મેરે તુમ હી એક,'), false);
    // Verse markers are structural, not junk.
    assert.equal(isJunkLine('ટેક'), false);
    assert.equal(isJunkLine('12'), false);
    // Pre-existing behaviour, kept deliberately: the min-length guard runs before the
    // marker test, so a single-character line is dropped. Live pages carry verse numbers
    // as suffixes ("Mādho 1"), never as standalone lines, so nothing is lost.
    assert.equal(isJunkLine('2'), true);
});

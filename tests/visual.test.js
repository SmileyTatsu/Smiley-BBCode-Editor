import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { parse } from '../js/parser.js';
import { render } from '../js/render.js';
import { sample } from '../js/sample.js';
import { balancedSegments } from '../js/editor.js';
import { scan, serialize, pointToOffset, offsetToPoint } from '../js/visual.js';

const dom = new JSDOM('<!doctype html><div id="root"></div>');
globalThis.document = dom.window.document;

// draws text the way the visual tab does and reads it back
function draw(text) {
    const root = document.getElementById('root');
    const { nodes } = parse(text);
    const fragment = render(nodes, {
        inline: () => undefined,
        collapseOpen: true,
        collapseState: new Map(),
        spoilerState: new Set(),
        warnings: [],
        editable: true,
    });
    root.replaceChildren(fragment);
    return root;
}

const roundTrip = text => serialize(draw(text));

test('the example text survives drawing and reading back unchanged', () => {
    assert.equal(roundTrip(sample), sample);
});

test('every kind of tag reads back as it was written', () => {
    const cases = [
        'plain text\nwith lines\n\n',
        '[b]bold[/b] [i]it[/i] [u]u[/u] [s]s[/s]',
        '[b][i]nested [u]deep[/u][/i][/b]',
        '[color=red]red[/color] [color=Nope]bad[/color] [color=]none[/color]',
        '[big]big[/big][small]small[/small]x[sup]2[/sup]y[sub]1[/sub]',
        '[center]a[/center][left]b[/left][right]c[/right][justify]d[/justify]',
        '[indent]in[/indent][heading]head[/heading][quote]q[/quote]',
        '[collapse=Title]body\n[collapse=[hr]Inner[hr]]x[/collapse][/collapse]',
        '[spoiler]secret [b]bold[/b][/spoiler]',
        'a [hr] b',
        '[url=https://example.com]Example[/url] and [url]https://example.org[/url]',
        'bare https://example.com/page here',
        '[url=javascript:alert(1)]bad[/url] [url][/url]',
        '[noparse][b]not bold[/b][/noparse]',
        '[icon]some name[/icon][eicon]smile[/eicon][user]Bob[/user]',
        '[img=3]a picture[/img] [img=x]bad[/img]',
        '[center][b]a[/b]\n[/center]',
        '[big][eicon]no[/eicon][/big]',
    ];

    for (const text of cases) assert.equal(roundTrip(text), text, text);
});

test('zero-width spaces and non-breaking spaces do not reach the BBCode', () => {
    const root = draw('[b]x[/b]');
    root.querySelector('strong').firstChild.data = '\u200bhello\u00a0there';
    assert.equal(serialize(root), '[b]hello there[/b]');
});

test('browser placeholders and ghost line breaks are ignored', () => {
    const root = draw('a');
    root.append(document.createElement('br'));
    const ghost = document.createElement('br');
    ghost.dataset.ghost = '';
    root.append(ghost);
    assert.equal(serialize(root), 'a');
});

test('an element emptied of text still reads back as its tags', () => {
    assert.equal(roundTrip('[b][/b]'), '[b][/b]');
    assert.equal(roundTrip('[center][/center]'), '[center][/center]');
});

test('positions in the text and in the page map to each other', () => {
    const text = 'ab [b]cd[/b] [icon]x[/icon] ef';
    const root = draw(text);
    const scanned = scan(root);

    for (const leaf of scanned.leaves) {
        for (let offset = leaf.start; offset <= leaf.end; offset++) {
            const [node, at] = offsetToPoint(root, scanned, offset);
            const back = pointToOffset(scanned, node, at);

            // an atom's inside is its whole text, so only its edges are caret spots
            if (leaf.atom && offset > leaf.start && offset < leaf.end) continue;
            assert.equal(back, offset, `offset ${offset}`);
        }
    }
});

test('a position inside a tag moves to the next text', () => {
    const root = draw('a[b]cd[/b]');
    const scanned = scan(root);
    const [node, at] = offsetToPoint(root, scanned, 2); // inside "[b]"
    assert.equal(node.data, 'cd');
    assert.equal(at, 0);
});

test('selections that hold half of a tag pair are split', () => {
    const text = '[b]foo bar[/b]baz';
    assert.deepEqual(balancedSegments(text, 4, text.length), [
        [4, 10],
        [14, 17],
    ]);
    assert.deepEqual(balancedSegments('x [b]yz[/b]', 0, 6), [
        [0, 2],
        [5, 6],
    ]);
    // already balanced: one piece, and a caret stays a caret
    assert.deepEqual(balancedSegments('[b]x[/b] y', 0, 10), [[0, 10]]);
    assert.deepEqual(balancedSegments('abc', 1, 1), [[1, 1]]);
});

// the whole visual tab, in a fake page

function setup(text, start = 0, end = start) {
    const window = new JSDOM(
        '<!doctype html><div id="wrap"><textarea id="t"></textarea><div id="v" contenteditable="true" hidden></div></div>'
    ).window;

    globalThis.document = window.document;
    globalThis.getSelection = () => window.getSelection();
    globalThis.Event = window.Event;
    window.document.execCommand = () => false; // makes the editor use setRangeText

    const textarea = window.document.getElementById('t');
    const root = window.document.getElementById('v');
    textarea.value = text;
    textarea.setSelectionRange(start, end);

    return { window, textarea, root, visual: null };
}

async function make(text, start, end) {
    const page = setup(text, start, end);
    const { createEditor } = await import('../js/editor.js');
    const { createVisual } = await import('../js/visual.js');

    const editor = createEditor(page.textarea);
    page.visual = createVisual({
        textarea: page.textarea,
        root: page.root,
        editor,
        ui: { toggleColors() {} },
        dialog: {},
    });
    page.visual.show();
    return page;
}

test('visual: the toolbar wraps the selected text and keeps it selected', async () => {
    const { textarea, root, visual } = await make('hello world', 0, 5);
    visual.adapter.wrap('b');

    assert.equal(textarea.value, '[b]hello[/b] world');
    assert.equal(root.querySelector('strong').textContent, 'hello');
    assert.equal(root.ownerDocument.getSelection().toString(), 'hello');

    // applying it again takes it off
    visual.adapter.wrap('b');
    assert.equal(textarea.value, 'hello world');
});

test('visual: a selection over half a tag pair stays properly nested', async () => {
    const { textarea, visual } = await make('[b]foo bar[/b]baz', 7, 17);
    visual.adapter.wrap('i');
    assert.equal(textarea.value, '[b]foo [i]bar[/i][/b][i]baz[/i]');
});

test('visual: typing in the page is read back into the BBCode', async () => {
    const { window, textarea, root } = await make('[b]hi[/b]');
    root.querySelector('strong').firstChild.data = 'hi there';
    root.dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.equal(textarea.value, '[b]hi there[/b]');
});

test('visual: Enter adds a line break, and a trailing one gets a spot for the caret', async () => {
    const { window, textarea, root } = await make('line');
    const text = root.firstChild;
    window.getSelection().collapse(text, 4);

    const event = new window.InputEvent('beforeinput', {
        inputType: 'insertParagraph',
        cancelable: true,
    });
    root.dispatchEvent(event);

    assert.equal(event.defaultPrevented, true);
    assert.equal(textarea.value, 'line\n');
    assert.ok(root.querySelector('br[data-ghost]'));
    assert.equal(serialize(root), 'line\n');
});

test('visual: undo and redo go through the BBCode', async () => {
    const { window, textarea, root, visual } = await make('abc', 0, 3);
    visual.adapter.wrap('b');
    visual.adapter.wrap('i');
    assert.equal(textarea.value, '[b][i]abc[/i][/b]');

    const undo = key =>
        root.dispatchEvent(
            new window.KeyboardEvent('keydown', {
                key,
                ctrlKey: true,
                shiftKey: key === 'Z',
                bubbles: true,
            })
        );
    undo('z');
    assert.equal(textarea.value, '[b]abc[/b]');
    undo('z');
    assert.equal(textarea.value, 'abc');
    undo('Z');
    assert.equal(textarea.value, '[b]abc[/b]');
});

test('visual: going back to the BBCode tab keeps the caret where it was', async () => {
    const { window, textarea, root, visual } = await make('[b]ab[/b]cd');
    window.getSelection().collapse(root.lastChild, 1);
    window.document.dispatchEvent(new window.Event('selectionchange')); // browsers do this
    visual.hide();
    assert.equal(textarea.selectionStart, 10); // between c and d
    assert.equal(root.hidden, true);
});

test('visual: a marked line is highlighted, and unmarking clears it', async () => {
    const highlights = new Map();
    globalThis.CSS = { highlights };
    globalThis.Highlight = class {
        constructor(range) {
            this.range = range;
        }
    };

    try {
        const { visual } = await make('first\n[b]second[/b]\nthird');
        visual.setMark({ start: 6, end: 19 });
        assert.equal(highlights.get('warning-line').range.toString(), 'second');

        visual.setMark(null);
        assert.equal(highlights.has('warning-line'), false);
    } finally {
        delete globalThis.CSS;
        delete globalThis.Highlight;
    }
});

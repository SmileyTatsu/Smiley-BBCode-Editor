import { parse } from './parser.js';
import { render } from './render.js';
import { findImage } from './inlines.js';
import { findShortcut } from './editor.js';

// The visual tab shows the rendered BBCode and lets you type in it. The BBCode text
// (the textarea) stays the one source of truth:
//   - typing in the page is read back into BBCode (scan), nothing is redrawn
//   - toolbar actions run on the BBCode text, then the page is drawn again
// Elements made by render({ editable: true }) carry data-tag/data-param (formatting)
// or data-bbcode (an "atom": link, icon, rule... shown, but not typed into).

const INLINE = new Set([
    'b',
    'i',
    'u',
    's',
    'color',
    'sub',
    'sup',
    'big',
    'small',
]);
const BLOCKS = 'div, blockquote, h2';
const ZERO_WIDTH = /\u200b/g;

// the zero-width spaces only give the caret somewhere to be in an empty element
const visible = text => text.replace(ZERO_WIDTH, '');

const ignored = node =>
    'ghost' in node.dataset || 'skip' in node.dataset || node.tagName === 'BR';

function openTag(element) {
    const { tag, param } = element.dataset;
    return param || tag === 'color' || tag === 'collapse'
        ? `[${tag}=${param}]`
        : `[${tag}]`;
}

// reads the BBCode back out of the page: { text, leaves }, where each leaf is a text
// node or atom with the range of text it covers
export function scan(root) {
    let text = '';
    const leaves = [];

    function walk(parent) {
        for (const node of parent.childNodes) {
            if (node.nodeType === 3) {
                const value = visible(node.data).replace(/\u00a0/g, ' ');
                leaves.push({
                    node,
                    start: text.length,
                    end: text.length + value.length,
                });
                text += value;
            } else if (node.nodeType === 1 && !ignored(node)) {
                const source = node.dataset.bbcode;

                if (source !== undefined) {
                    leaves.push({
                        node,
                        atom: true,
                        start: text.length,
                        end: text.length + source.length,
                    });
                    text += source;
                } else if (node.dataset.tag) {
                    text += openTag(node);
                    walk(node);
                    text += `[/${node.dataset.tag}]`;
                } else {
                    // anything the browser added itself is flattened away
                    walk(node);
                }
            }
        }
    }

    walk(root);
    return { text, leaves };
}

export const serialize = root => scan(root).text;

const indexIn = node =>
    Array.prototype.indexOf.call(node.parentNode.childNodes, node);

// the position in the BBCode of a point in the page
export function pointToOffset({ text, leaves }, node, offset) {
    if (node.nodeType === 3) {
        const leaf = leaves.find(other => other.node === node);
        if (leaf)
            return leaf.start + visible(node.data.slice(0, offset)).length;
    }

    // a point between nodes: the start of the first thing after it
    const probe = document.createRange();
    probe.setStart(node, offset);
    probe.collapse(true);

    for (const leaf of leaves) {
        const compared = leaf.atom
            ? probe.comparePoint(leaf.node.parentNode, indexIn(leaf.node))
            : probe.comparePoint(leaf.node, 0);
        if (compared >= 0) return leaf.start;
    }

    return text.length;
}

// where in a text node the n-th visible character is
function rawIndex(data, count) {
    let seen = 0;
    for (let i = 0; i < data.length; i++) {
        if (seen === count) return i;
        if (data[i] !== '\u200b') seen++;
    }
    return data.length;
}

// the point in the page for a position in the BBCode. A position inside tag
// syntax moves to the start of the next text.
export function offsetToPoint(root, { leaves }, offset) {
    for (const leaf of leaves) {
        if (offset > leaf.end && leaf !== leaves.at(-1)) continue;

        const at = Math.min(offset, leaf.end);
        if (leaf.atom) {
            const parent = leaf.node.parentNode;
            const index = indexIn(leaf.node);
            return [parent, at <= leaf.start ? index : index + 1];
        }

        return [
            leaf.node,
            rawIndex(leaf.node.data, Math.max(at - leaf.start, 0)),
        ];
    }

    return [root, 0];
}

// a block that ends in a line break needs one more thing after it, or the new line
// would not show up until something is typed on it
function lastText(parent) {
    for (let node = parent.lastChild; node; node = node.previousSibling) {
        if (node.nodeType === 3) {
            if (visible(node.data) !== '') return node;
        } else if (node.nodeType === 1 && !ignored(node)) {
            if (node.dataset.bbcode !== undefined || node.matches(BLOCKS))
                return null;

            const inner = lastText(node);
            if (inner !== undefined) return inner;
        }
    }

    return undefined;
}

const endsInNewline = block => {
    const last = lastText(block);
    return Boolean(last) && visible(last.data).endsWith('\n');
};

const RAW_NAMES = {
    icon: 'Character name',
    eicon: 'Eicon name',
    user: 'Character name',
    noparse: 'Text to show as it is',
};

export function createVisual({ textarea, root, editor, ui, dialog }) {
    const collapseState = new Map();
    let active = false;
    let lastRange = null; // the latest selection inside the page
    let lastSel = null; // the same as offsets, kept across redraws
    let history = [];
    let position = -1;
    let pushedAt = 0;
    let marked = null; // { start, end } in the BBCode: a line to highlight

    // selection

    function currentSel() {
        const inside = node => node && root.contains(node);

        if (
            lastRange &&
            inside(lastRange.startContainer) &&
            inside(lastRange.endContainer)
        ) {
            const scanned = scan(root);
            return {
                start: pointToOffset(
                    scanned,
                    lastRange.startContainer,
                    lastRange.startOffset
                ),
                end: pointToOffset(
                    scanned,
                    lastRange.endContainer,
                    lastRange.endOffset
                ),
            };
        }

        const end = textarea.value.length;
        return lastSel ?? { start: end, end };
    }

    function setSelection(start, end) {
        const scanned = scan(root);
        const range = document.createRange();
        range.setStart(...offsetToPoint(root, scanned, start));
        range.setEnd(...offsetToPoint(root, scanned, end));

        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        lastRange = range.cloneRange();
    }

    document.addEventListener('selectionchange', () => {
        if (!active) return;

        const selection = getSelection();
        if (
            selection.rangeCount &&
            root.contains(selection.anchorNode) &&
            root.contains(selection.focusNode)
        ) {
            lastRange = selection.getRangeAt(0).cloneRange();
        }
    });

    // drawing, and reading back

    function rerender(start, end) {
        const { nodes } = parse(textarea.value);
        const fragment = render(nodes, {
            inline: findImage,
            collapseOpen: true,
            collapseState,
            spoilerState: new Set(),
            warnings: [],
            editable: true,
        });

        root.replaceChildren(fragment);
        tidy();
        paintMark();

        if (start === undefined) return;
        lastSel = { start, end };
        root.focus({ preventScroll: true });
        setSelection(start, end);
    }

    // the highlight is a Range, which the browser keeps in place while you type, and
    // it is drawn again from the offsets after every redraw
    function paintMark() {
        const highlights = globalThis.CSS?.highlights;
        if (!highlights || typeof Highlight === 'undefined') return;

        highlights.delete('warning-line');
        if (!active || !marked || marked.start >= marked.end) return;

        const scanned = scan(root);
        const range = document.createRange();
        range.setStart(...offsetToPoint(root, scanned, marked.start));
        range.setEnd(...offsetToPoint(root, scanned, marked.end));
        highlights.set('warning-line', new Highlight(range));
    }

    // BBCode text from the page, passed on so the raw text and the preview follow
    function sync() {
        const { text } = scan(root);
        if (text === textarea.value) return;

        textarea.value = text;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // cleans up what editing leaves behind
    function tidy() {
        const selection = getSelection();
        const anchor = selection.anchorNode;

        for (const element of root.querySelectorAll('[data-tag]')) {
            const empty =
                visible(element.textContent) === '' &&
                !element.querySelector('[data-bbcode]');

            // formatting with nothing in it goes, unless the caret is in it, as when
            // you switch bold on and have not typed yet
            if (
                empty &&
                INLINE.has(element.dataset.tag) &&
                !element.contains(anchor)
            ) {
                element.remove();
            }
        }

        // the browser's own placeholders, and the line-end ones from the last round
        for (const br of root.querySelectorAll('br')) br.remove();

        // an element emptied by deleting still needs a place for the caret
        for (const element of root.querySelectorAll(
            '[data-tag], .collapse-content'
        )) {
            if (element.firstChild || element.dataset.bbcode !== undefined)
                continue;

            const spot = document.createTextNode('\u200b');
            element.appendChild(spot);
            if (anchor === element) selection.collapse(spot, 0);
        }

        for (const block of [root, ...root.querySelectorAll(BLOCKS)]) {
            if (!endsInNewline(block)) continue;

            const br = document.createElement('br');
            br.dataset.ghost = '';
            block.appendChild(br);
        }
    }

    // typing into the page

    function insertText(text) {
        const selection = getSelection();
        if (!selection.rangeCount || !root.contains(selection.anchorNode))
            return;

        const range = selection.getRangeAt(0);
        if (!range.collapsed) range.deleteContents();

        let { startContainer: node, startOffset: offset } = range;

        if (node.nodeType !== 3) {
            const before = node.childNodes[offset - 1];
            const after = node.childNodes[offset];

            if (before?.nodeType === 3) {
                node = before;
                offset = before.length;
            } else if (after?.nodeType === 3) {
                node = after;
                offset = 0;
            } else {
                const created = document.createTextNode('');
                node.insertBefore(created, after ?? null);
                node = created;
                offset = 0;
            }
        }

        node.insertData(offset, text);
        selection.collapse(node, offset + text.length);
    }

    function changed(coalesce) {
        tidy();
        sync();
        record(coalesce);
    }

    // undo and redo: the browser's own would not know what we did to the page

    function record(coalesce) {
        const entry = { text: textarea.value, sel: currentSel() };
        const now = Date.now();

        if (history[position]?.text === entry.text) {
            history[position] = entry;
        } else if (
            coalesce &&
            position > 0 &&
            position === history.length - 1 &&
            now - pushedAt < 700
        ) {
            // quick typing is one undo step
            history[position] = entry;
        } else {
            history.length = position + 1;
            history.push(entry);
            position++;

            if (history.length > 200) {
                history.shift();
                position--;
            }
        }

        pushedAt = now;
    }

    function undo(direction) {
        const next = position + direction;
        if (next < 0 || next >= history.length) return;

        position = next;
        const { text, sel } = history[position];
        textarea.value = text;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        rerender(sel.start, sel.end);
    }

    root.addEventListener('beforeinput', event => {
        const type = event.inputType;

        if (type === 'insertParagraph' || type === 'insertLineBreak') {
            event.preventDefault();
            insertText('\n');
            changed(false);
        } else if (type === 'historyUndo' || type === 'historyRedo') {
            event.preventDefault();
            undo(type === 'historyUndo' ? -1 : 1);
        } else if (
            type.startsWith('format') ||
            type.endsWith('Drop') ||
            type === 'deleteByDrag'
        ) {
            event.preventDefault();
        }
    });

    root.addEventListener('input', event => {
        if (!event.isComposing) changed(true);
    });
    root.addEventListener('compositionend', () => changed(true));

    // only plain text goes in, line breaks and all
    root.addEventListener('paste', event => {
        event.preventDefault();
        const text = event.clipboardData
            .getData('text/plain')
            .replace(/\r\n?/g, '\n');
        if (!text) return;

        insertText(text);
        changed(false);
    });
    root.addEventListener('drop', event => event.preventDefault());

    root.addEventListener('keydown', event => {
        const mod = (event.ctrlKey || event.metaKey) && !event.altKey;
        const key = event.key.toLowerCase();

        if (mod && (key === 'z' || key === 'y')) {
            event.preventDefault();
            undo(key === 'y' || event.shiftKey ? 1 : -1);
            return;
        }

        const item = findShortcut(event);
        if (!item) return;

        event.preventDefault();
        (item.keyRun || item.run)(adapter, ui);
    });

    // links and the like are edited, not followed
    root.addEventListener('click', event => {
        if (event.target.closest('a')) event.preventDefault();
    });

    root.addEventListener('dblclick', event => {
        const header = event.target.closest('.collapse-header');
        if (header) {
            editCollapse(header.parentNode);
            return;
        }

        const atom = event.target.closest('[data-bbcode]');
        if (atom) editAtom(atom);
    });

    // dialogs

    function ask(title, fields) {
        return new Promise(resolve => {
            const inputs = fields.map(field => {
                const input = Object.assign(document.createElement('input'), {
                    type: 'text',
                    value: field.value ?? '',
                    placeholder: field.placeholder ?? '',
                });

                const label = document.createElement('label');
                label.append(field.label, input);
                return { name: field.name, input, label };
            });

            dialog.querySelector('.ask-title').textContent = title;
            dialog
                .querySelector('.ask-fields')
                .replaceChildren(...inputs.map(it => it.label));
            dialog.returnValue = '';

            dialog.addEventListener(
                'close',
                () => {
                    resolve(
                        dialog.returnValue === 'ok'
                            ? Object.fromEntries(
                                  inputs.map(it => [it.name, it.input.value])
                              )
                            : null
                    );
                },
                { once: true }
            );

            dialog.showModal();
            inputs[0].input.select();
        });
    }

    // changes made straight to the page (a title, a link) are read back and redrawn
    function commit() {
        const sel = currentSel();
        sync();
        rerender(sel.start, sel.end);
        record(false);
    }

    async function editCollapse(outer) {
        const answer = await ask('Collapse title', [
            { name: 'title', label: 'Title', value: outer.dataset.param },
        ]);
        if (!answer) return;

        outer.dataset.param = answer.title.trim();
        commit();
    }

    async function editAtom(atom) {
        const source = atom.dataset.bbcode;
        const kind = atom.dataset.kind;
        const match = /^\[(\w+)(?:=([^\]]*))?\]([\s\S]*)\[\/\w+\]$/.exec(
            source
        );
        if (!match) return; // a bare web address, a rule, or text shown as it is
        const [, , param = '', content] = match;

        let fields;
        let build;

        if (kind === 'url') {
            fields = [
                { name: 'address', label: 'Address', value: param || content },
                {
                    name: 'text',
                    label: 'Link text',
                    value: param ? content : '',
                },
            ];
            build = v =>
                v.text.trim()
                    ? `[url=${v.address.trim()}]${v.text.trim()}[/url]`
                    : `[url]${v.address.trim()}[/url]`;
        } else if (kind === 'img') {
            fields = [
                { name: 'id', label: 'Image id', value: param },
                { name: 'name', label: 'Name', value: content },
            ];
            build = v => `[img=${v.id.trim()}]${v.name}[/img]`;
        } else if (RAW_NAMES[kind]) {
            fields = [
                { name: 'value', label: RAW_NAMES[kind], value: content },
            ];
            build = v => `[${kind}]${v.value}[/${kind}]`;
        } else {
            return;
        }

        const answer = await ask(`Change ${kind}`, fields);
        if (!answer) return;

        atom.dataset.bbcode = build(answer);
        commit();
    }

    // toolbar actions run on the BBCode text, then the page is drawn again

    function apply(operation) {
        const sel = currentSel();
        sync();
        textarea.setSelectionRange(sel.start, sel.end);

        // keeps the tags properly nested when the selection holds half of a pair
        editor.balanced = true;
        try {
            operation(editor);
        } finally {
            editor.balanced = false;
        }

        rerender(textarea.selectionStart, textarea.selectionEnd);
        record(false);
    }

    const collapsed = () => {
        const { start, end } = currentSel();
        return start === end;
    };

    async function insertNamed(tag) {
        const answer = await ask(`Insert ${tag}`, [
            { name: 'value', label: RAW_NAMES[tag] },
        ]);
        const value = answer?.value.trim();
        if (value) apply(it => it.insert(`[${tag}]${value}[/${tag}]`));
    }

    // looks like the textarea's editor, so the toolbar and shortcuts need no changes
    const adapter = {
        wrap(tag) {
            if (RAW_NAMES[tag] && collapsed()) insertNamed(tag);
            else apply(it => it.wrap(tag));
        },

        color: name => apply(it => it.color(name)),
        colorPrompt: () => ui.toggleColors(),
        insert: text => apply(it => it.insert(text)),

        async collapse() {
            const answer = await ask('Collapse title', [
                { name: 'title', label: 'Title' },
            ]);
            if (answer)
                apply(it => it.wrapParam('collapse', answer.title.trim()));
        },

        async url() {
            const selecting = !collapsed();
            const fields = [
                { name: 'address', label: 'Address', placeholder: 'https://' },
            ];
            if (!selecting) fields.push({ name: 'text', label: 'Link text' });

            const answer = await ask('Insert link', fields);
            const address = answer?.address.trim();
            if (!address) return;

            const text = answer.text?.trim();
            apply(it => {
                if (selecting) it.wrapParam('url', address);
                else
                    it.insert(
                        text
                            ? `[url=${address}]${text}[/url]`
                            : `[url]${address}[/url]`
                    );
            });
        },

        replaceAll(text) {
            editor.replaceAll(text);
            resetHistory(0, 0);
            rerender(0, 0);
        },

        jumpTo(index) {
            root.focus({ preventScroll: true });
            setSelection(index, index);

            const { startContainer } = getSelection().getRangeAt(0);
            const target =
                startContainer.nodeType === 3
                    ? startContainer.parentElement
                    : startContainer;
            target.scrollIntoView({ block: 'center' });
        },
    };

    function resetHistory(start, end) {
        history = [{ text: textarea.value, sel: { start, end } }];
        position = 0;
    }

    return {
        adapter,

        get active() {
            return active;
        },

        show() {
            active = true;
            root.hidden = false;
            root.parentNode.classList.add('visual-on');

            const { selectionStart: start, selectionEnd: end } = textarea;
            resetHistory(start, end);
            rerender(start, end);
        },

        hide() {
            if (!active) return;

            const { start, end } = currentSel();
            sync();
            active = false;
            paintMark();
            root.hidden = true;
            root.parentNode.classList.remove('visual-on');

            textarea.focus({ preventScroll: true });
            textarea.setSelectionRange(start, end);
        },

        // the text or the images changed from outside, so draw it again
        refresh() {
            if (!active) return;

            const { start, end } = currentSel();
            rerender(start, end);
        },

        jumpTo: adapter.jumpTo,

        // highlights a stretch of the BBCode (null for none), like a warning's line
        setMark(range) {
            marked = range;
            paintMark();
        },
    };
}

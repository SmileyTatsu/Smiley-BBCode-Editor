import { completeColor } from './tags.js';
import { readTag, findCloser } from './parser.js';

const URL_LIKE = /^(?:(?:https?|ftps?|irc):\/\/|www\.)\S+$/i;
const COLOR_OPEN = /\[color=([a-z]*)$/i;

// what's typed so far in a [color=...] when the selection ends at its ], else null
export function colorParam(value, start, end) {
    if (start === 0 || value[end] !== ']') return null;

    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    const match = COLOR_OPEN.exec(value.slice(lineStart, start));
    return match ? { prefix: match[1], close: end } : null;
}

// Wrapping a selection that holds only half of a tag pair would cross the tags, as in
// [i]x[/b]y[/i]. This cuts such tags out of [start, end) and returns the stretches
// between them, which can each be wrapped on their own.
export function balancedSegments(text, start, end) {
    if (start >= end) return [[start, end]];

    const cuts = [];
    const open = [];
    let i = start;

    while ((i = text.indexOf('[', i)) !== -1 && i < end) {
        const tok = readTag(text, i);
        if (!tok || tok.end > end) {
            i++;
            continue;
        }

        i = tok.end;
        if (tok.closing) {
            const k = open.findLastIndex(other => other.name === tok.name);
            if (k === -1) cuts.push(tok);
            else open.length = k;
        } else if (tok.def.kind === 'container') {
            open.push(tok);
        } else if (tok.def.kind === 'raw') {
            const close = findCloser(text, tok.end, tok.name);
            if (close && close.index + close[0].length <= end)
                i = close.index + close[0].length;
        }
    }

    cuts.push(...open);
    cuts.sort((a, b) => a.start - b.start);

    const parts = [];
    let from = start;
    for (const cut of cuts) {
        if (cut.start > from) parts.push([from, cut.start]);
        from = cut.end;
    }
    if (from < end) parts.push([from, end]);
    return parts;
}

export function createEditor(textarea) {
    let completing = false;

    // goes through execCommand so the browser keeps its undo history
    function replace(start, end, text, selStart, selEnd) {
        textarea.focus();
        textarea.setSelectionRange(start, end);

        if (!document.execCommand('insertText', false, text)) {
            textarea.setRangeText(text, start, end, 'end');
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }

        textarea.setSelectionRange(selStart, selEnd);
    }

    // removes open/close if they are already around the selection
    function unwrap(open, close) {
        const { selectionStart: start, selectionEnd: end, value } = textarea;
        const selected = value.slice(start, end);

        const tagsInside =
            selected.length >= open.length + close.length &&
            selected.startsWith(open) &&
            selected.endsWith(close);

        if (tagsInside) {
            const inner = selected.slice(
                open.length,
                selected.length - close.length
            );
            replace(start, end, inner, start, start + inner.length);
            return true;
        }

        const tagsOutside =
            value.slice(start - open.length, start) === open &&
            value.slice(end, end + close.length) === close;

        if (tagsOutside) {
            const from = start - open.length;
            replace(
                from,
                end + close.length,
                selected,
                from,
                from + selected.length
            );
            return true;
        }

        return false;
    }

    // caretInOpen puts the caret inside the opening tag, for tags with a parameter
    function wrapWith(open, close, caretInOpen) {
        if (caretInOpen === undefined && api.balanced) {
            wrapBalanced(open, close);
            return;
        }

        wrapOne(open, close, caretInOpen);
    }

    // wraps each balanced stretch of the selection on its own, last first so the
    // earlier offsets stay valid
    function wrapBalanced(open, close) {
        const { selectionStart: start, selectionEnd: end, value } = textarea;
        const parts = balancedSegments(value, start, end);
        if (parts.length === 0) return;

        for (const [from, to] of parts.toReversed()) {
            textarea.setSelectionRange(from, to);
            wrapOne(open, close);
        }

        const grown = textarea.value.length - value.length;
        textarea.setSelectionRange(textarea.selectionStart, end + grown);
    }

    function wrapOne(open, close, caretInOpen) {
        if (caretInOpen === undefined && unwrap(open, close)) return;

        const { selectionStart: start, selectionEnd: end, value } = textarea;
        const selected = value.slice(start, end);

        const caret = start + (caretInOpen ?? open.length);
        const selEnd =
            caretInOpen === undefined ? caret + selected.length : caret;
        replace(start, end, open + selected + close, caret, selEnd);
    }

    const api = {
        // set by the visual editor, which has to keep its tags properly nested
        balanced: false,

        wrap: tag => wrapWith(`[${tag}]`, `[/${tag}]`),
        wrapParam: (tag, param) => wrapWith(`[${tag}=${param}]`, `[/${tag}]`),
        color: name => wrapWith(`[color=${name}]`, '[/color]'),
        colorPrompt: () => wrapWith('[color=]', '[/color]', '[color='.length),
        collapse: () =>
            wrapWith('[collapse=]', '[/collapse]', '[collapse='.length),

        url() {
            const {
                selectionStart: start,
                selectionEnd: end,
                value,
            } = textarea;

            if (URL_LIKE.test(value.slice(start, end)))
                wrapWith('[url]', '[/url]');
            else wrapWith('[url=]', '[/url]', '[url='.length);
        },

        insert(text) {
            const end = textarea.selectionEnd;
            replace(end, end, text, end + text.length, end + text.length);
        },

        replaceAll: text => replace(0, textarea.value.length, text, 0, 0),

        jumpTo(index) {
            textarea.focus();
            textarea.setSelectionRange(index, index);

            const line = textarea.value.slice(0, index).split('\n').length - 1;
            const lineHeight =
                parseFloat(getComputedStyle(textarea).lineHeight) || 20;
            textarea.scrollTop = Math.max(
                0,
                line * lineHeight - textarea.clientHeight / 3
            );
        },

        // while a color name is typed, fills in the rest once only one color fits
        handleInput(event) {
            if (completing || event.inputType !== 'insertText') return;

            const { value, selectionStart: at, selectionEnd } = textarea;
            const param = colorParam(value, at, selectionEnd);
            const name = param && completeColor(param.prefix);
            if (!name || name.length === param.prefix.length) return;

            // the added part stays selected, so the next key replaces it
            const rest = name.slice(param.prefix.length);
            completing = true;
            replace(at, at, rest, at, at + rest.length);
            completing = false;
        },

        // Tab, Enter or ] in a color parameter moves the caret past the ]
        handleKeydown(event) {
            const plain = !(event.ctrlKey || event.metaKey || event.altKey);
            const accepts =
                event.key === ']' ||
                event.key === 'Enter' ||
                (event.key === 'Tab' && !event.shiftKey);
            if (!plain || !accepts) return false;

            const { value, selectionStart, selectionEnd } = textarea;
            const param = colorParam(value, selectionStart, selectionEnd);
            if (!param) return false;

            event.preventDefault();
            textarea.setSelectionRange(param.close + 1, param.close + 1);
            return true;
        },
    };

    return api;
}

const alignIcon = path =>
    `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="${path}"/></svg>`;

// key is Ctrl/Cmd plus that key; keyRun replaces run when used as a shortcut
const button = (label, title, run, extra) => ({ label, title, run, ...extra });
const wrap = tag => editor => editor.wrap(tag);

export const TOOLBAR = [
    [
        button('B', 'Bold', wrap('b'), { key: 'b', cls: 'bold' }),
        button('I', 'Italic', wrap('i'), { key: 'i', cls: 'italic' }),
        button('U', 'Underline', wrap('u'), { key: 'u', cls: 'underline' }),
        button('S', 'Strikethrough', wrap('s'), { key: 's', cls: 'strike' }),
        button('A+', 'Big text', wrap('big'), { key: 'arrowup' }),
        button('A−', 'Small text', wrap('small'), { key: 'arrowdown' }),
        button('x²', 'Superscript', wrap('sup'), {
            key: 'arrowup',
            shift: true,
        }),
        button('x₂', 'Subscript', wrap('sub'), {
            key: 'arrowdown',
            shift: true,
        }),
        button(
            'Color',
            'Color swatches (the shortcut types the name instead)',
            (editor, ui) => ui.toggleColors(),
            { key: 'd', cls: 'wide', keyRun: editor => editor.colorPrompt() }
        ),
    ],
    [
        button('', 'Align left', wrap('left'), {
            icon: alignIcon('M3 6h18M3 12h12M3 18h15'),
        }),
        button('', 'Align center', wrap('center'), {
            icon: alignIcon('M3 6h18M7 12h10M5 18h14'),
        }),
        button('', 'Align right', wrap('right'), {
            icon: alignIcon('M3 6h18M9 12h12M7 18h14'),
        }),
        button('', 'Justify', wrap('justify'), {
            icon: alignIcon('M3 6h18M3 12h18M3 18h18'),
        }),
        button('Indent', 'Indent', wrap('indent'), { cls: 'wide' }),
        button('H', 'Heading', wrap('heading'), { cls: 'bold' }),
        button('Quote', 'Quote', wrap('quote'), { cls: 'wide' }),
        button('Collapse', 'Collapse', editor => editor.collapse(), {
            cls: 'wide',
        }),
        button('HR', 'Horizontal rule', editor => editor.insert('[hr]'), {
            cls: 'wide',
        }),
    ],
    [
        button('Link', 'Link', editor => editor.url(), {
            key: 'l',
            cls: 'wide',
        }),
        button('User', 'Character link', wrap('user'), {
            key: 'r',
            cls: 'wide',
        }),
        button('Icon', 'Character icon', wrap('icon'), {
            key: 'o',
            cls: 'wide',
        }),
        button('EIcon', 'Emoticon (eicon)', wrap('eicon'), {
            key: 'e',
            cls: 'wide',
        }),
        button('Spoiler', 'Spoiler', wrap('spoiler'), {
            key: 'k',
            cls: 'wide',
        }),
        button('Noparse', 'Noparse (show tags as text)', wrap('noparse'), {
            cls: 'wide',
        }),
    ],
];

export function findShortcut(event) {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return undefined;

    const key = event.key.toLowerCase();
    return TOOLBAR.flat().find(
        item => item.key === key && Boolean(item.shift) === event.shiftKey
    );
}

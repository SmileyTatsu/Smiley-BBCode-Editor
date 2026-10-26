const STATIC_URL = 'https://static.f-list.net/images/';
const SITE_URL = 'https://www.f-list.net/c/';

// tags that are just an element with a class: [element, class]
const SIMPLE = {
    b: ['strong'],
    i: ['em'],
    u: ['u'],
    s: ['del'],
    sub: ['sub'],
    sup: ['sup'],
    big: ['span', 'big'],
    small: ['span', 'small'],
    left: ['div', 'align-left'],
    center: ['div', 'align-center'],
    right: ['div', 'align-right'],
    justify: ['div', 'align-justify'],
    indent: ['div', 'indent'],
    heading: ['h2', 'heading'],
};

const imageName = name => encodeURIComponent(name.toLowerCase());
const avatarUrl = name => `${STATIC_URL}avatar/${imageName(name)}.png`;
const eiconUrl = name => `${STATIC_URL}eicon/${imageName(name)}.gif`;
const profileUrl = name => SITE_URL + encodeURIComponent(name);

function el(tag, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
}

function externalLink(href) {
    const a = el('a');
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
}

// options: inline(id) finds a local image, collapseOpen is the starting state of
// collapses, collapseState and spoilerState remember what the user clicked, and
// warnings collects problems found while rendering
export function render(nodes, options) {
    const { collapseState, spoilerState, warnings } = options;

    // editable is for the visual editor: it adds the data the editor reads the
    // text back from, and makes links, icons and the like uneditable blocks
    const editable = Boolean(options.editable);

    // collapses and spoilers are identified by their order in the text
    let collapseCount = 0;
    let spoilerCount = 0;

    function appendAll(parent, children) {
        for (const child of children) renderNode(parent, child);
    }

    // an atom is shown but not typed into; data-bbcode is what it is written back as
    function atom(element, source, kind) {
        element.setAttribute('contenteditable', 'false');
        element.dataset.bbcode = source;
        element.dataset.kind = kind;
        return element;
    }

    // an element with nothing in it gets a zero-width space, so the caret can sit in it
    function keepCaretSpot(element) {
        if (editable && !element.firstChild)
            element.appendChild(document.createTextNode('\u200b'));
    }

    function renderNode(parent, node) {
        if (node.type === 'text') {
            if (editable && node.source !== undefined) {
                const span = el('span', 'atom-text');
                span.textContent = node.value;
                parent.appendChild(atom(span, node.source, 'text'));
                return;
            }
            parent.appendChild(document.createTextNode(node.value));
        } else if (node.type === 'void') {
            const rule = el('hr');
            parent.appendChild(editable ? atom(rule, '[hr]', 'hr') : rule);
        } else if (node.type === 'url') {
            const link = renderUrl(node);
            parent.appendChild(
                editable ? atom(link, node.source, 'url') : link
            );
        } else if (node.type === 'raw') {
            const raw = renderRaw(node);
            parent.appendChild(
                editable ? atom(raw, node.source, node.tag) : raw
            );
        } else {
            renderElement(parent, node);
        }
    }

    function renderUrl(node) {
        const wrap = el('span');

        const icon = el('i', 'link-icon');
        icon.setAttribute('aria-hidden', 'true');

        const a = externalLink(node.url);
        a.className = 'link';
        a.rel = 'nofollow noreferrer noopener';
        a.textContent = node.text;

        const domain = el('span', 'link-domain');
        domain.textContent = ` [${node.domain}]`;

        wrap.append(icon, ' ', a, domain);
        return wrap;
    }

    function renderRaw(node) {
        if (node.tag === 'noparse') {
            const span = el('span');
            span.textContent = node.text;
            return span;
        }

        if (node.tag === 'user') {
            const a = externalLink(profileUrl(node.name));
            a.textContent = node.name;
            return a;
        }

        if (node.tag === 'icon') {
            const a = externalLink(profileUrl(node.name));
            a.appendChild(
                renderAvatar(node.name, 'icon', avatarUrl(node.name))
            );
            return a;
        }

        if (node.tag === 'eicon') {
            return renderAvatar(node.name, 'eicon', eiconUrl(node.name));
        }

        return renderInline(node);
    }

    function renderAvatar(name, kind, src) {
        const img = el('img', `avatar ${kind}`);
        img.src = src;
        img.alt = img.title = name;
        img.addEventListener('error', () => img.classList.add('broken'));
        return img;
    }

    function renderInline(node) {
        const found = options.inline(node.id);

        if (!found) {
            warnings.push({
                message: `No local image for [img=${node.id}]. Add one in the Inline images panel.`,
                index: node.index,
            });

            const box = el('div', 'inline-missing');
            box.textContent = `[img=${node.id}] ${node.name}`.trim();
            return box;
        }

        const wrap = el('div', 'inline-image');
        const img = el('img');
        img.src = found.url;
        img.alt = img.title = node.name || found.name;
        wrap.appendChild(img);
        return wrap;
    }

    function mark(element, node) {
        if (!editable) return;
        element.dataset.tag = node.tag;
        element.dataset.param = node.param;
    }

    function renderElement(parent, node) {
        if (node.tag === 'collapse') return renderCollapse(parent, node);
        if (node.tag === 'spoiler') return renderSpoiler(parent, node);

        let out;
        if (node.tag === 'color') {
            out = el('span');

            // node.color is always one of the known names, never user text
            if (node.color) {
                out.style.color = `var(--c-${node.color})`;
                out.dataset.color = node.color;
            }
        } else if (node.tag === 'quote') {
            out = el('blockquote');
            const header = el('div', 'quote-header');
            header.textContent = 'Quote:';
            if (editable) {
                header.setAttribute('contenteditable', 'false');
                header.dataset.skip = '';
            }
            out.appendChild(header);
        } else {
            const [tag, className] = SIMPLE[node.tag];
            out = el(tag, className);
        }

        mark(out, node);
        parent.appendChild(out);
        appendAll(out, node.children);
        keepCaretSpot(out);
    }

    function renderSpoiler(parent, node) {
        // while editing, a spoiler is always open, with an outline to show it is one
        if (editable) {
            const shown = el('span', 'spoiler-edit');
            mark(shown, node);
            parent.appendChild(shown);
            appendAll(shown, node.children);
            keepCaretSpot(shown);
            return;
        }

        const key = spoilerCount++;

        const wrap = el('span');
        const toggle = el('a', 'spoiler-tag');
        toggle.href = '#';
        toggle.textContent = '[click to show spoiler]';
        const content = el('span', 'spoiler-content');

        function show(shown) {
            toggle.hidden = shown;
            content.hidden = !shown;
        }

        show(spoilerState.has(key));
        toggle.addEventListener('click', event => {
            event.preventDefault();
            spoilerState.add(key);
            show(true);
        });

        wrap.append(toggle, content);
        parent.appendChild(wrap);
        appendAll(content, node.children);
    }

    function renderCollapse(parent, node) {
        const key = collapseCount++;
        const startsOpen = collapseState.has(key)
            ? collapseState.get(key)
            : options.collapseOpen;

        const outer = el('div', 'collapse');
        const header = el('div', 'collapse-header');
        header.tabIndex = 0;
        header.setAttribute('role', 'button');
        appendTitle(header, node.param);

        if (editable) {
            mark(outer, node);
            header.setAttribute('contenteditable', 'false');
            header.dataset.skip = '';
            header.title = 'Double-click to change the title';
        }

        // the extra inner div is what lets the body animate to zero height
        const body = el('div', 'collapse-body');
        const inner = el('div', 'collapse-body-inner');
        const content = el('div', 'collapse-content');
        inner.appendChild(content);
        body.appendChild(inner);

        outer.append(header, body);
        parent.appendChild(outer);
        appendAll(content, node.children);
        keepCaretSpot(content);

        function setOpen(open) {
            outer.classList.toggle('open', open);
            header.setAttribute('aria-expanded', String(open));
        }

        function toggle() {
            const open = !outer.classList.contains('open');
            collapseState.set(key, open);
            setOpen(open);
        }

        setOpen(startsOpen);
        header.addEventListener('click', toggle);
        header.addEventListener('keydown', event => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            toggle();
        });
    }

    // the title is plain text, but [hr] in it draws a rule
    function appendTitle(header, title) {
        const parts = title.split(/\[hr\]/i);

        // a rule at the very start goes above the chevron
        if (parts[0] === '' && parts.length > 1) {
            header.appendChild(el('hr'));
            parts.shift();
        }

        const chevron = el('span', 'collapse-chevron');
        chevron.setAttribute('aria-hidden', 'true');
        header.appendChild(chevron);

        parts.forEach((part, index) => {
            if (index > 0) header.appendChild(el('hr'));
            if (part) header.appendChild(document.createTextNode(part));
        });
    }

    const fragment = document.createDocumentFragment();
    appendAll(fragment, nodes);
    return fragment;
}

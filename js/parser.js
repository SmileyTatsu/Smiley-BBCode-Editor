import { COLORS, defs, NAME_RE, URL_RE, FIND_URL_RE } from './tags.js';

// parse(text) returns { nodes, warnings }; tests/parser.test.js shows the node shapes

const TAG_START_RE = /\[(\/)?\s*([a-z]+)\s*(=)?/iy;
const HR_RE = /\[hr\]/iy;

function isHrAt(input, index) {
    HR_RE.lastIndex = index;
    return HR_RE.test(input);
}

// finds the ] that ends a tag parameter, or -1 if this isn't a tag
function scanParam(input, from, name) {
    for (let p = from; p < input.length; p++) {
        const c = input[p];

        if (c === '\n') return -1;
        if (c === ']') return p;

        if (c === '[') {
            // a collapse title may hold [hr], so that ] doesn't end the tag
            if (name !== 'collapse') return -1;
            if (isHrAt(input, p)) p += 3;
        }
    }

    return -1;
}

export function readTag(input, start) {
    TAG_START_RE.lastIndex = start;
    const match = TAG_START_RE.exec(input);
    if (!match) return null;

    const name = match[2].toLowerCase();
    if (!Object.hasOwn(defs, name)) return null;

    const closing = Boolean(match[1]);
    const hasParam = Boolean(match[3]);
    let pos = TAG_START_RE.lastIndex;
    let param = '';

    if (hasParam) {
        if (closing) return null;

        const end = scanParam(input, pos, name);
        if (end === -1) return null;

        param = input.slice(pos, end).trim();
        pos = end;
    }

    if (input[pos] !== ']') return null;
    return { closing, name, def: defs[name], param, start, end: pos + 1 };
}

export function findCloser(input, from, name) {
    const re = new RegExp('\\[\\s*/\\s*' + name + '\\s*\\]', 'ig');
    re.lastIndex = from;
    return re.exec(input);
}

function fixUrl(url) {
    if (/^www\./i.test(url)) url = 'https://' + url;
    return url.replace(/ /g, '%20');
}

function resolveUrl(node, warn) {
    const url = fixUrl((node.param || node.content).trim());
    const text = node.param ? node.content || node.param : node.content;

    // source is the text as typed, so the visual editor can write it back unchanged
    const source = node.source ?? node.content;

    if (!url) {
        warn('[url] has no address.', node.index);
        return { type: 'text', value: '', source };
    }

    if (!URL_RE.test(url)) {
        warn(
            `"${url}" is not a valid link (http, https, ftp or irc).`,
            node.index
        );
        return { type: 'text', value: `[BAD URL] ${url}`, source };
    }

    const host = /^[a-z]+:\/\/(?:www\.)?([^/]+)/i.exec(url);
    const domain = host ? host[1] : url;
    return { type: 'url', url, text, domain, index: node.index, source };
}

// turns the raw text between a tag pair into a node
function resolveRaw(node, warn) {
    const { tag, param, content, index } = node;

    if (param && tag !== 'url' && tag !== 'img') {
        warn(`[${tag}] does not take a parameter.`, index);
    }

    if (tag === 'noparse') {
        return { type: 'raw', tag, text: content, index, source: node.source };
    }

    if (tag === 'url') {
        return resolveUrl(node, warn);
    }

    if (tag === 'img') {
        if (!/^\d+$/.test(param)) {
            warn('[img] needs a numeric id, like [img=123]name[/img].', index);
            return { type: 'text', value: node.source };
        }
        return {
            type: 'raw',
            tag,
            id: parseInt(param, 10),
            name: content.trim(),
            index,
            source: node.source,
        };
    }

    // icon, eicon and user
    const name = content.trim();
    if (!NAME_RE.test(name)) {
        warn(`[${tag}] needs a plain name; shown as text.`, index);
        return { type: 'text', value: node.source };
    }
    return { type: 'raw', tag, name, index, source: node.source };
}

function checkParam(node, warn) {
    if (node.tag === 'color') {
        const color = node.param.toLowerCase();
        node.color = COLORS.includes(color) ? color : null;

        if (!node.color) {
            warn(
                node.param
                    ? `Unknown color "${node.param}". Use: ${COLORS.join(', ')}.`
                    : '[color] needs a color name, like [color=red].',
                node.index
            );
        }
    } else if (node.tag === 'collapse') {
        if (!node.param) warn('[collapse] has no title.', node.index);
    } else if (node.param) {
        warn(`[${node.tag}] does not take a parameter.`, node.index);
    }
}

// allowed is a Set of tag names, or null when anything goes
function isAllowed(allowed, name) {
    return allowed === null || allowed.has(name);
}

function childAllowed(parentAllowed, def) {
    if (!def.allow) return parentAllowed;
    if (parentAllowed === null) return new Set(def.allow);
    return new Set(def.allow.filter(name => parentAllowed.has(name)));
}

export function parse(input) {
    const warnings = [];
    const warn = (message, index) => warnings.push({ message, index });

    const rootNode = { type: 'root', children: [] };
    const stack = [{ node: rootNode, name: null, allowed: null, index: 0 }];
    const top = () => stack[stack.length - 1];

    // everything before textStart has already been turned into nodes
    let textStart = 0;

    function addText(value, index) {
        const frame = top();
        const out = frame.node.children;

        if (!isAllowed(frame.allowed, 'url')) {
            out.push({ type: 'text', value });
            return;
        }

        // bare web addresses become links
        let last = 0;
        for (const match of value.matchAll(FIND_URL_RE)) {
            if (match.index > last) {
                out.push({
                    type: 'text',
                    value: value.slice(last, match.index),
                });
            }

            const found = {
                param: '',
                content: match[0],
                index: index + match.index,
            };
            out.push(resolveUrl(found, warn));
            last = match.index + match[0].length;
        }

        if (last < value.length) {
            out.push({ type: 'text', value: value.slice(last) });
        }
    }

    function flush(end) {
        if (end > textStart) addText(input.slice(textStart, end), textStart);
        textStart = end;
    }

    function handleClose(tok) {
        const frame = top();

        if (frame.name === tok.name) {
            flush(tok.start);
            stack.pop();
            textStart = tok.end;
        } else if (stack.some(other => other.name === tok.name)) {
            warn(
                `Unexpected [/${tok.name}]: [${frame.name}] is still open.`,
                tok.start
            );
        } else {
            warn(`[/${tok.name}] was never opened.`, tok.start);
        }
    }

    function handleOpen(tok) {
        const frame = top();

        if (!isAllowed(frame.allowed, tok.name)) {
            warn(
                `[${tok.name}] cannot be used inside [${frame.name}]; shown as text.`,
                tok.start
            );
            return;
        }

        const kind = tok.def.kind;

        if (kind === 'void') {
            flush(tok.start);
            if (tok.param)
                warn(`[${tok.name}] does not take a parameter.`, tok.start);

            frame.node.children.push({
                type: 'void',
                tag: tok.name,
                index: tok.start,
            });
            textStart = tok.end;
        } else if (kind === 'raw') {
            const close = findCloser(input, tok.end, tok.name);
            if (!close) {
                warn(
                    `[${tok.name}] was never closed; shown as text.`,
                    tok.start
                );
                return;
            }

            flush(tok.start);
            const stop = close.index + close[0].length;
            const raw = {
                tag: tok.name,
                param: tok.param,
                content: input.slice(tok.end, close.index),
                source: input.slice(tok.start, stop),
                index: tok.start,
            };

            frame.node.children.push(resolveRaw(raw, warn));
            textStart = stop;
        } else {
            flush(tok.start);
            const node = {
                type: 'el',
                tag: tok.name,
                param: tok.param,
                children: [],
                index: tok.start,
            };
            checkParam(node, warn);

            frame.node.children.push(node);
            stack.push({
                node,
                name: tok.name,
                allowed: childAllowed(frame.allowed, tok.def),
                index: tok.start,
            });
            textStart = tok.end;
        }
    }

    let i = 0;
    while (i < input.length) {
        const bracket = input.indexOf('[', i);
        if (bracket === -1) break;

        const tok = readTag(input, bracket);
        if (!tok) {
            i = bracket + 1;
            continue;
        }

        if (tok.closing) handleClose(tok);
        else handleOpen(tok);

        // a raw tag eats its content, so carry on after it
        i = Math.max(tok.end, textStart);
    }

    flush(input.length);

    for (let k = stack.length - 1; k > 0; k--) {
        const { name, index } = stack[k];
        warn(
            `[${name}] was never closed; closed automatically at the end.`,
            index
        );
    }

    return { nodes: rootNode.children, warnings };
}

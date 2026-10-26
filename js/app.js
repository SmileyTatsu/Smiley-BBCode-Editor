import { COLORS } from './tags.js';
import { parse } from './parser.js';
import { render } from './render.js';
import { highlight } from './highlight.js';
import { createEditor, TOOLBAR, findShortcut } from './editor.js';
import {
    images,
    findImage,
    addImages,
    setImageId,
    removeImage,
} from './inlines.js';
import { sample } from './sample.js';
import { createVisual } from './visual.js';

const $ = id => document.getElementById(id);
const make = (tag, props) => Object.assign(document.createElement(tag), props);

const input = $('input');
const preview = $('preview');
const colorPopover = $('color-popover');
const backdrop = $('backdrop');
const linemark = $('linemark');

function syncScroll() {
    for (const layer of [backdrop, linemark]) {
        layer.scrollTop = input.scrollTop;
        layer.scrollLeft = input.scrollLeft;
    }
}

// the warning last clicked; its line stays highlighted until the warning is gone
let pinned = null;

// the warning may have moved or gone since the text changed: follow the one with
// the same message nearest to where it was
function trackPinned(warnings) {
    if (!pinned) return;

    const same = warnings.filter(warning => warning.message === pinned.message);
    if (!same.length) {
        pinned = null;
        return;
    }

    const distance = warning => Math.abs(warning.index - pinned.index);
    pinned.index = same.reduce((best, warning) =>
        distance(warning) < distance(best) ? warning : best
    ).index;
}

function drawPinned(text) {
    let range = null;

    if (pinned) {
        const start = pinned.index
            ? text.lastIndexOf('\n', pinned.index - 1) + 1
            : 0;
        const found = text.indexOf('\n', pinned.index);
        range = { start, end: found === -1 ? text.length : found };
    }

    // the BBCode tab: text before, the line, text after, so it lines up with the text
    if (range) {
        const line = make('mark', {
            textContent: text.slice(range.start, range.end),
        });
        linemark.replaceChildren(
            text.slice(0, range.start),
            line,
            text.slice(range.end) + '\n'
        );
    } else {
        linemark.replaceChildren();
    }

    visual.setMark(range);
}

const visualPane = $('visual');

const SETTINGS_KEY = 'fbb.settings';
const TAB_KEY = 'fbb.tab';
const DRAFT_KEY = 'fbb.draft';
const DEFAULTS = { theme: 'default', palette: 'classic', collapse: 'open' };

// localStorage can throw (private windows, blocked cookies); the editor works without it
function save(key, value) {
    try {
        localStorage.setItem(key, value);
    } catch {}
}

function load(key) {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

function loadSettings() {
    try {
        return { ...DEFAULTS, ...JSON.parse(load(SETTINGS_KEY)) };
    } catch {
        return { ...DEFAULTS };
    }
}

const settings = loadSettings();
const collapseState = new Map();
const spoilerState = new Set();
const editor = createEditor(input);

// preview

function showWarnings(warnings, text) {
    const count = warnings.length;
    $('warnings-summary').textContent = count
        ? `${count} warning${count === 1 ? '' : 's'}`
        : 'No warnings';
    $('warnings').classList.toggle('has-warnings', count > 0);

    const items = warnings.map(warning => {
        const line = text.slice(0, warning.index).split('\n').length;
        const button = make('button', {
            type: 'button',
            className: 'warning-link',
            textContent: `Line ${line}: ${warning.message}`,
        });
        button.addEventListener('click', () => {
            pinned = { message: warning.message, index: warning.index };
            drawPinned(input.value);
            target().jumpTo(warning.index);
        });

        const item = make('li');
        item.appendChild(button);
        return item;
    });

    $('warnings-list').replaceChildren(...items);
}

function update() {
    const text = input.value;
    const { nodes, warnings } = parse(text);

    const fragment = render(nodes, {
        inline: findImage,
        collapseOpen: settings.collapse === 'open',
        collapseState,
        spoilerState,
        warnings,
    });
    preview.replaceChildren(fragment);

    // the trailing newline keeps a final empty line from collapsing
    backdrop.innerHTML = highlight(text) + '\n';
    syncScroll();

    warnings.sort((a, b) => a.index - b.index);
    trackPinned(warnings);
    drawPinned(text);
    showWarnings(warnings, text);
    $('count').textContent = `${text.length.toLocaleString()} characters`;
    save(DRAFT_KEY, text);
}

// eicon sync

const UNSYNCED = 'img.eicon:not([data-synced])';
const eiconBlobs = new Map();
let eiconUrls = [];

// only fetch if it's not in cache
function fetchEicon(src) {
    if (!eiconBlobs.has(src)) {
        const blob = fetch(src).then(response => {
            if (!response.ok) throw new Error(response.statusText);
            return response.blob();
        });

        blob.catch(() => eiconBlobs.delete(src));
        eiconBlobs.set(src, blob);
    }

    return eiconBlobs.get(src);
}

async function syncEicons() {
    const all = preview.querySelectorAll('img.eicon');
    if (![...all].every(img => img.complete)) return;

    // an eicon used twice shares one URL, and a failed download keeps the plain image
    const urls = new Map();
    const sources = new Set(
        [...preview.querySelectorAll(UNSYNCED)].map(img => img.src)
    );

    await Promise.all(
        [...sources].map(async src => {
            try {
                urls.set(src, URL.createObjectURL(await fetchEicon(src)));
            } catch {}
        })
    );

    // data-synced keeps the loads of the new URLs from starting another sync
    for (const img of preview.querySelectorAll(UNSYNCED)) {
        if (!urls.has(img.src)) continue;
        img.dataset.synced = '';
        img.src = urls.get(img.src);
    }

    // syncs can overlap, so only URLs that no eicon is using are revoked
    const inUse = new Set(
        [...preview.querySelectorAll('img.eicon')].map(img => img.src)
    );

    eiconUrls = [...eiconUrls, ...urls.values()].filter(url => {
        if (inUse.has(url)) return true;
        URL.revokeObjectURL(url);
    });
}

// prevent an error blocking things
for (const type of ['load', 'error']) {
    preview.addEventListener(
        type,
        event => {
            if (event.target.matches(UNSYNCED)) syncEicons();
        },
        true
    );
}

// toolbar

const ui = {
    toggleColors() {
        colorPopover.hidden = !colorPopover.hidden;
    },
};

// the visual tab edits through the same toolbar; target() is whichever is showing
const visual = createVisual({
    textarea: input,
    root: visualPane,
    editor,
    ui,
    dialog: $('ask'),
});
const target = () => (visual.active ? visual.adapter : editor);

function showTab(name) {
    const isVisual = name === 'visual';
    if (isVisual === visual.active) return;

    if (isVisual) visual.show();
    else visual.hide();

    $('tab-source').setAttribute('aria-selected', String(!isVisual));
    $('tab-visual').setAttribute('aria-selected', String(isVisual));
    save(TAB_KEY, name);
}

$('tab-source').addEventListener('click', () => showTab('source'));
$('tab-visual').addEventListener('click', () => showTab('visual'));

// keeps the selection in the visual tab while a toolbar button is pressed
$('toolbar').addEventListener('mousedown', event => {
    if (visual.active) event.preventDefault();
});

function shortcutLabel(item) {
    if (!item.key) return '';

    const arrows = { arrowup: '↑', arrowdown: '↓' };
    const key = arrows[item.key] || item.key.toUpperCase();
    return ` (Ctrl+${item.shift ? 'Shift+' : ''}${key})`;
}

function buildToolbar() {
    TOOLBAR.forEach((group, index) => {
        if (index > 0)
            $('toolbar').appendChild(
                make('span', { className: 'toolbar-divider' })
            );

        for (const item of group) {
            const button = make('button', {
                type: 'button',
                className: `tb ${item.cls || ''}`.trim(),
                title: item.title + shortcutLabel(item),
            });

            // icons are fixed SVG strings from editor.js
            if (item.icon) button.innerHTML = item.icon;
            else button.textContent = item.label;

            button.addEventListener('click', () => item.run(target(), ui));
            $('toolbar').appendChild(button);
        }
    });

    for (const name of COLORS) {
        const swatch = make('button', {
            type: 'button',
            className: 'swatch',
            title: name,
        });
        swatch.style.background = `var(--c-${name})`;
        swatch.setAttribute('aria-label', name);

        swatch.addEventListener('click', () => {
            colorPopover.hidden = true;
            target().color(name);
        });
        colorPopover.appendChild(swatch);
    }
}

input.addEventListener('keydown', event => {
    if (editor.handleKeydown(event)) return;

    const item = findShortcut(event);
    if (!item) return;

    event.preventDefault();
    (item.keyRun || item.run)(editor, ui);
});

input.addEventListener('input', event => {
    editor.handleInput(event);
    update();
});

input.addEventListener('scroll', syncScroll);

document.addEventListener('keydown', event => {
    if (event.key === 'Escape') colorPopover.hidden = true;
});

// settings

function applySettings() {
    // only the preview gets the theme; the editor and swatches stay readable on dark
    preview.dataset.theme = settings.theme;

    // the swatches share the preview's palette
    preview.dataset.palette = settings.palette;
    visualPane.dataset.theme = settings.theme;
    visualPane.dataset.palette = settings.palette;
    colorPopover.dataset.palette = settings.palette;
    backdrop.dataset.palette = settings.palette;
}

function bindSetting(name) {
    const select = $(`setting-${name}`);
    select.value = settings[name];

    select.addEventListener('change', () => {
        settings[name] = select.value;
        save(SETTINGS_KEY, JSON.stringify(settings));

        if (name === 'collapse') collapseState.clear();
        applySettings();
        update();
    });
}

// header buttons

$('copy').addEventListener('click', async event => {
    const button = event.currentTarget;

    try {
        await navigator.clipboard.writeText(input.value);
    } catch {
        input.select();
        document.execCommand('copy');
    }

    button.textContent = 'Copied';
    setTimeout(() => (button.textContent = 'Copy BBCode'), 1500);
});

$('example').addEventListener('click', () => {
    const replacing = input.value.trim() !== '';
    if (replacing && !confirm('Replace the current text with the example?'))
        return;

    target().replaceAll(sample);
    collapseState.clear();
    spoilerState.clear();
});

// inline images

function imageRow(image) {
    const thumb = make('img', { src: image.url, alt: '' });

    const id = make('input', {
        type: 'number',
        min: '0',
        value: image.id,
        title: 'The id used in [img=ID]',
    });
    id.setAttribute('aria-label', 'Image id');
    id.addEventListener('change', () => {
        if (setImageId(image, Number(id.value))) {
            refreshImages();
            return;
        }

        // the id was taken or invalid: put the old one back and flash red
        id.value = image.id;
        id.classList.add('invalid');
        setTimeout(() => id.classList.remove('invalid'), 800);
    });

    const name = make('input', {
        type: 'text',
        value: image.name,
        title: 'Name used when inserting the tag',
    });
    name.setAttribute('aria-label', 'Image name');
    name.addEventListener('change', () => (image.name = name.value));

    const insert = make('button', {
        type: 'button',
        className: 'btn',
        textContent: 'Insert',
    });
    insert.addEventListener('click', () =>
        editor.insert(`[img=${image.id}]${image.name}[/img]`)
    );

    const remove = make('button', {
        type: 'button',
        className: 'btn',
        textContent: '✕',
        title: 'Remove image',
    });
    remove.setAttribute('aria-label', 'Remove image');
    remove.addEventListener('click', () => {
        removeImage(image);
        refreshImages();
    });

    const row = make('li', { className: 'inline-row' });
    row.append(thumb, id, name, insert, remove);
    return row;
}

// redraws the image list and the preview, which may use those images
function refreshImages() {
    $('inline-list').replaceChildren(...images.map(imageRow));
    $('inline-count').textContent = images.length ? `(${images.length})` : '';
    update();
    visual.refresh();
}

function addFiles(files) {
    const skipped = addImages(Array.from(files));
    if (skipped)
        alert(`${skipped} file(s) were skipped because they are not images.`);
    refreshImages();
}

$('inline-add').addEventListener('click', () => $('inline-file').click());
$('inline-file').addEventListener('change', event => {
    addFiles(event.target.files);
    event.target.value = '';
});

const dropzone = $('inlines');
dropzone.addEventListener('dragover', event => {
    if (!event.dataTransfer.types.includes('Files')) return;

    event.preventDefault();
    dropzone.classList.add('dragging');
});
dropzone.addEventListener('dragleave', () =>
    dropzone.classList.remove('dragging')
);
dropzone.addEventListener('drop', event => {
    event.preventDefault();
    dropzone.classList.remove('dragging');
    addFiles(event.dataTransfer.files);
});

// start

buildToolbar();
for (const name of Object.keys(DEFAULTS)) bindSetting(name);
applySettings();

const draft = load(DRAFT_KEY);
input.value = draft === null ? sample : draft;
update();

if (load(TAB_KEY) === 'visual') showTab('visual');

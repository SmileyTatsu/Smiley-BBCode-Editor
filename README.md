# Smiley BBCode Editor

A small, static, local-first editor and previewer for F-List BBCode. Write on
the left, see the result on the right. No build step: it is plain HTML, CSS and
JavaScript, so it runs as-is on GitHub Pages.

The only things it fetches from F-List are character icons and eicons
(`static.f-list.net`), which are shown with `<img>` tags.

## Running it

- **Locally:** `npm run serve`, then open the address it prints. The page uses
  ES modules, which browsers won't load from a double-clicked `index.html`.
- **GitHub Pages:** push the repository and enable Pages for the branch root.
  Nothing else is needed.

## Features

- Toolbar and shortcuts: `Ctrl/Cmd` + `B` `I` `U` `S` `D`(color) `L`(link)
  `R`(user) `O`(icon) `E`(eicon) `K`(spoiler), `↑`/`↓` for big/small and
  `Shift+↑`/`Shift+↓` for sup/sub. Applying a wrap twice removes it. Edits go
  through the browser's own undo, so `Ctrl+Z` keeps working. The browser may
  grab a few shortcuts for itself.
- **Visual tab.** Next to the BBCode tab, it shows your text formatted like the
  preview, and you can type in it. The BBCode, the preview and the warnings
  follow as you type, and the toolbar and shortcuts work the same way. Enter adds
  a line break and pasting keeps only plain text. Links, icons, eicons, users,
  images, rules and `[noparse]` are blocks: delete them as a whole, and
  double-click one to change it. Double-click a collapse title to rename it.
  Collapses and spoilers are always open here, and a spoiler has a dashed
  outline. `Ctrl+Z` / `Ctrl+Y` undo and redo within this tab. A selection that
  holds half of a tag pair is split so the tags stay nested. Switching tabs
  keeps your caret. Editing here writes the BBCode again from what is on the
  page, so it tidies it: tags come out lower case, an unclosed tag gets its
  closing tag, and formatting with nothing inside is dropped. Text you type
  that looks like a tag, such as `[b]`, is plain text on the page and becomes a
  tag when you next open the tab.
- **Color by typing.** `Ctrl+D` inserts `[color=]` with the caret right after
  the `=`. Type the start of a color and it is completed when only one color
  fits (`r` gives red). When several fit, such as `g` (green, gray), keep typing
  until one does. The completed part is selected, so the next key replaces it,
  and Backspace drops it. `Tab`, `Enter` or `]` accept and move past the `]`.
  If nothing matches you can type anything. The toolbar's Color button shows
  swatches instead.
- **Collapses start open** so they do not fold up while you edit, and a
  collapse you open or close stays that way while you type. "Collapses start:
  Closed" shows them as they first appear to a reader.
- **Warnings** under the preview: unclosed or mismatched tags, tags used
  where they are not allowed, bad colors, bad links, missing inline images.
  Click one to jump to its line.
- A **Classic / Vanilla** color palette, to check that your colors stay
  readable with either.
- A **Dark / Default / Light** preview theme, to see how your profile looks to
  readers with each. On Light, Classic colors change the way Horizon's Light
  theme does: white and gray become the same shade, and cyan, yellow, pink and
  green get darker. Only the preview changes; the editor stays dark.
- **Inline images, local only.** `[img=ID]name[/img]` shows an image you add
  from your own computer under "Inline images". Give each image the id your
  profile uses. Images are kept in memory only, so add them again after a
  reload, and are never uploaded.
- Your text and settings are remembered in `localStorage` (images are not).

## How the preview behaves

The preview follows one rule: show what a strict reader would show, so problems
appear here and not after you publish.

- Tags nest strictly. An unclosed tag closes at the end of the text, and a
  closing tag that does not match stays as plain text.
- Some tags limit what may appear inside them, and the limit carries down. For
  example `[big]` and `[small]` only allow url, i, u, b, color, s and hr; so an
  `[eicon]` inside `[big]` is shown as text, with a warning.
- `[url]`, `[icon]`, `[eicon]`, `[user]`, `[img]` and `[noparse]` take their
  contents literally; tags inside them are not parsed.
- Colors are the twelve names only. Anything else (a hex code, for example)
  gets no color and a warning.
- Links accept `http`, `https`, `ftp` and `irc` only. Bare web addresses become
  links on their own.
- A line break is a line break; the preview does not add extra ones around
  blocks. This means a line break straight after `[collapse=Title]` shows as a
  blank line at the top of the collapse (on top of its padding). Write the text
  right after the `]` to avoid it. A line break before `[/collapse]` adds
  nothing.
- `[collapse=Title]` titles are plain text, except that `[hr]` in a title draws
  a rule.
- `[icon]` and `[eicon]` are always 50×50.
- `[indent]` grows with the window width (none on narrow windows).

The sizes, spacing and structure of every tag were compared with a replica of
Horizon's markup and styles (Bootstrap 5.3.8 plus its BBCode rules) and match
exactly, with collapses open and closed. Colors, fonts and the link and
chevron icons are approximations, since they depend on Horizon's theme and
FontAwesome.

Not implemented: `[row]`/`[col]` and `[session]`/`[channel]`. There is no chat
preview; the preview always shows how a profile looks.

## Safety

The preview is built with DOM calls (`createElement`, `textContent`), never
`innerHTML`, and names and links are validated, so pasted BBCode cannot inject
markup or scripts.

## Project layout

```
index.html        page
css/editor.css    the page around the preview
css/preview.css   how rendered BBCode looks
js/tags.js        tag table: what exists, what may go inside what
js/parser.js      text -> tree + warnings (no DOM, so Node can test it)
js/render.js      tree -> DOM
js/editor.js      textarea editing helpers and the toolbar definition
js/visual.js      the Visual tab: reads BBCode back out of the page
js/inlines.js     the local inline images
js/sample.js      example text
js/app.js         wires everything together
tests/            parser, editor and visual tab tests
```

## Development

```
npm install
npm run format        # Prettier, writes changes
npm run format:check  # Prettier, check only
npm test              # Node's built-in test runner (the visual tests use jsdom)
```

Formatting is handled by Prettier (`.prettierrc.json`, `.editorconfig`). Run
`npm run format` before committing.

## References

The parser and renderer here are an original rewrite. While planning them,
the [Horizon](https://github.com/Fchat-Horizon/Horizon) F-Chat client's BBCode
code was read to understand how F-List BBCode is meant to work: which tags
exist, how they nest, the allow-lists, the `[collapse]`/`[hr]` title handling,
the icon and inline image URLs, and the profile styles. No Horizon code was
copied. Horizon is licensed under MPL-2.0; if code is ever copied from it,
that license applies to the copied files.

## License

This project is licensed under the [GNU AGPL-3.0](LICENSE.md).

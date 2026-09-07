# Marketplace entry, icon, screenshots, and overview file

Read this file before you create a marketplace entry, icon, screenshots, or
overview file.
Confirm every field against schema/marketplace-v2.schema.json in the
marketplace repository.

## Create the entry

Create entries/<plugin-id>.json. The filename, entry ID, and plugin manifest ID
must match.

The schema rejects an unknown field. The permitted fields are id, displayName,
description, icon, tags, author, source, category, screenshots, and overview. The
schema requires id, displayName, description, icon, author, and source. The
build writes publishedAt itself, so do not author it.
The entry has no engines field and no version field. Read the plugin manifest
for compatibility data instead.

### Write the display name

Use the product name. Keep it short enough to read in a card title. Do not add
the word plugin. Do not add the word BB unless the product name holds it.

### Write the description

Write an App Store listing, not a README line. A user who never heard of the
plugin decides here. Do not copy the style of the current entries. Many of them
read as release notes.

An App Store listing has two parts. BB holds both in one field.

**The hook is the first sentence.** BB clamps the description to two lines in a
browse card, and to one line in a compact row. The hook must stand alone there.
State the outcome the user gets. Do not state the mechanism. Keep it under
about 140 characters. Start with a verb. Do not start with the display name.
Do not start with "A plugin that".

**The body is every sentence after the hook.** The detail page shows the body
in full. Give one distinct capability in each sentence. Put the most valuable
capability first. Stop at four sentences unless the plugin adds several
surfaces.

Write for a person who decides. Do not write for a reviewer who reads a
changelog. Use concrete nouns and verbs. Use a real number when you have one.
Never let an adjective carry the value.

Do not use these words: powerful, seamless, easy, simple, fast, best, modern,
beautiful, robust, and intuitive. Delete the word. State the fact that made you
reach for it. Do not compare the plugin with another plugin or product.

Name every cost in the body. State an external service, a paid account, a
separate install, or a limited operating system.

This description is weak:

```text
A powerful plugin that makes code review seamless and easy.
```

This description is better:

```text
Puts a second model on every code review, so a bug has to survive two
reviewers instead of one. Findings stay attached to the thread until you
resolve them, and a thread with open findings cannot report a clean review.
Runs on any provider you already installed.
```

The better text leads with the outcome. It then gives two concrete behaviors
and one requirement. It holds no adjective that carries value.

### Choose the tags

Use no more than ten specific lowercase tags. Each tag holds a maximum of 32
characters. Use hyphens inside a multiword tag. Repeat the words a user would
search for. Do not repeat the display name. Do not repeat the category ID.

### Name the author

Set author.github to the account that opens the pull request. Get it with:

```sh
gh api user --jq .login
```

Do not publish an email address.

Use this shape only as a guide:

```json
{
  "id": "notes",
  "displayName": "Notes",
  "description": "Keeps project notes beside each BB thread.",
  "icon": { "url": "./icons/notes-1234abcd.svg" },
  "screenshots": ["./screenshots/notes/overview.png"],
  "overview": "./overview/notes.md",
  "tags": ["notes", "interface"],
  "author": {
    "name": "Acme",
    "github": "acme",
    "url": "https://acme.example"
  },
  "category": "thread-content",
  "source": {
    "git": {
      "url": "https://github.com/acme/bb-plugin-notes.git",
      "range": "^1.2.3"
    }
  }
}
```

## Choose the category

Marketplace CI refuses a new or changed entry with no category. Set one
category ID from the categories array in marketplace.base.json. Read that file
for the current list. Do not invent a category ID.

Pick the category for the surface a user gets, not for the code inside. Ask the
user when two categories fit the plugin equally well.

## Add the icon

Vendor the icon in the marketplace icons/ directory. Do not use a remote URL,
a CDN, raw.githubusercontent.com, or a path in the plugin repository.

Use an existing brand icon when it meets the current marketplace rules. The
entry can also use a supported BB host icon name.

Use SVG, PNG, or WebP for a file icon. Keep it at or below 256 KB. Prefer a
simple square image with clear contrast at small sizes.

BB masks SVG icons with the surrounding text color. Use a single-color SVG for
theme-aware artwork. Use PNG or WebP for multicolor artwork. Do not include
scripts, remote resources, or private data in an SVG.

Use a content hash in the filename:

```sh
sha256sum path/to/icon.svg
shasum -a 256 path/to/icon.svg
```

Use the first available command. Name the file
<plugin-id>-<first-eight-sha256-characters>.<extension> and reference it as:

```json
"icon": { "url": "./icons/notes-1234abcd.svg" }
```

If no suitable artwork exists, select a host icon from the current supported
list. Do not invent a host icon name.

## Add screenshots

Add screenshots to every submission. The store detail page shows them, and a
user judges a plugin by them before an install. An entry with no screenshot
looks unfinished beside the entries around it.

An entry can reference a maximum of six. Two or three good images beat six weak
ones. Submit with no screenshot only when the plugin adds no visible surface,
or when the user refuses the images. State that reason in the pull request
body.

### Choose what to show

Lead with the surface a user gets first. Add one image for each further surface
that a description cannot carry, such as a panel, a settings page, or a command
result. Do not repeat one surface. Do not show a splash screen or a logo.

### Capture the images

Install the plugin in BB first. Capture the real plugin surface. Do not draw a
mockup. Do not reuse marketing artwork.

Use a browser or computer automation tool that the current harness supplies.
Look for a browser control skill, a computer use tool, or a screenshot tool in
the session. Drive BB with that tool. Open the plugin surface. Capture the
image.

If the harness supplies no such tool, ask the user for the images. Name each
surface to capture. State the file rules below. Wait for the files. Do not
submit an entry with no screenshots because a tool was absent.

Capture at a device pixel ratio of 2 when the tool permits it. A community
screenshot must be at least 1200 pixels wide. A narrow panel needs a wider
window, or a capture of the window around it.

Show real content in each image. Look at every image before you commit it.
Remove private data such as tokens, email addresses, home directory paths, and
unrelated thread text.

### Follow the file rules

Put each file in screenshots/<plugin-id>/. Use PNG, JPEG, or WebP. Make the
file extension match the real image format. Keep each file at or below 2 MiB.
Keep each image at least 1200 pixels wide.

Reference each file from the entry with a relative path:

```json
"screenshots": ["./screenshots/notes/overview.png"]
```

The marketplace build rejects a file in screenshots/ that no entry references.
Delete a file you do not reference. The build changes each local path to a CDN
URL. Do not write a CDN URL yourself. An absolute URL must use HTTPS on
getbb.app, so use a local path for a submission.

## Add the overview file

Every entry in the public marketplace needs an overview file. The plugin author
keeps the long-form description in a PLUGIN_OVERVIEW.md file beside the plugin
package.json. The store detail page shows the short description as a lead
paragraph under the plugin name, then an Overview section with this file. The
overview is the same claim as the short description at length: the same
outcome, the same surfaces, no capability the short text does not imply.

Copy the author's file when the plugin repository holds it. When it does not,
draft one from the behavior you observed while validating and screenshotting
the plugin, show the full text to the user, and get approval before you commit
it. Offer to add the same file to the plugin repository as PLUGIN_OVERVIEW.md
so the two stay together. Never invent a capability to fill the file.

Copy the file to overview/<plugin-id>.md in the marketplace repository. Reference
it from the entry with the exact relative path:

```json
"overview": "./overview/notes.md"
```

The marketplace build folds the file text into the published document. It
rejects a file in overview/ that no entry references.

### Follow the content rules

The file must be UTF-8 text with a maximum of 4000 characters. The build
rejects a longer file.

The file can use headings, paragraphs, emphasis, strong text, strikethrough,
inline code, code blocks, blockquotes, ordered lists, unordered lists,
thematic breaks, and links. Each link must be an absolute https URL. The store
opens each link in the browser.

The build rejects raw HTML, images, tables, footnotes, task lists, and control
characters. The store also removes such content at render time. Put images in
screenshots instead.

The store renders each heading in the file as a small uppercase label, so use
`##` headings for sections such as What you get, How it works, and
Requirements. Do not start the file with a `#` title. The page already shows
the plugin name. Do not repeat the short description as the first sentence.
The page shows it directly above.

Read the file before you copy it. Confirm every claim against the behavior you
observed. Remove private data, a local path, or an internal URL. Ask the user
before you change the author's text.

## Check the entry quality

Read the finished entry as a user who has never seen the plugin. Confirm each
statement below before you open the pull request.

- The hook states the outcome the user gets, not the mechanism.
- The hook survives a two-line clamp without loss of its main point.
- Each body sentence gives one distinct capability.
- Every claim in the description matches behavior you observed.
- The description names each external service, account, and separate install.
- The category matches the surface the user gets.
- The tags hold words a user would search for.
- The icon reads clearly at 40 pixels.
- The first screenshot shows the main surface with real content.
- The entry references an overview file, and the overview says the same thing
  as the short description at greater length.
- The overview file uses only the permitted markdown and https links.
- No field holds private data, a local path, or an internal URL.

Fix the entry when one statement fails. Do not submit an entry you cannot
defend.

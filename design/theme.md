# Quest log theme

Quest presents itself as an original quest log for your repository and your
agents. This page is the source of truth for that presentation: the status
markers, size colours, and mark. The CLI (`src/cli/theme.ts`) keeps a small
table that cites it.

The theme is presentation only. Quest files, `quest check`, `quest guide`, and
the skills keep the format's own terms (quest, epic, milestone, ready,
blocked, `Required`, `Goal`), with no display aliases. Its files live in
`design/theme/`, not `assets/`, which holds the agent contract embedded in the
binary.

## Rules

- Modern game UI, not fantasy pastiche. Use only genre conventions: `!` and
  `?` markers, a quest log, and rarity-coloured sizes. No names, art, fonts,
  icons, or screenshots from any game.
- Hand-written SVG and open-licensed fonts only.
- Never use colour as the only signal. Every marker and size colour comes with
  its text label.
- No XP, levels, achievements, or leaderboards.

## Voice

Lead with “Find your next quest.” Describe Quest as a shared quest log for you
and your coding agents. Show a concrete dependency and the pull request that
delivers the change.

Plain copy with a light game flavour. "Quest" and "quest log" are the product,
so they stay, along with the markers and size colours. Everything else reads
like a modern developer tool: no party, no gold, no roman numerals, no pixel
art or sound.

## Size

Quests are coloured by size along the loot-rarity ladder players already know:
grey, green, blue, purple, orange. Show the size label next to its colour.

| Size | Colour | Hex | Terminal SGR |
| --- | --- | --- | --- |
| XS | grey | `#9ba5b4` | `90` |
| S | green | `#4ade80` | `32` |
| M | blue | `#4da3ff` | `34` |
| L | purple | `#b98cff` | `35` |
| XL | orange | `#ff9a3c` | `33` |

XL has no extra tag: its orange and its size label already stand out.

Markers use the accent: amber (`#ffc53d`, SGR `33`) for `!` ready and `?` in
review, and grey (`#9ba5b4`, SGR `90`) for a blocked `!`.
Terminal colours are named ANSI SGR codes, so they follow the user's terminal
palette and work on any colour terminal. The 16-colour palette has no orange,
so XL uses yellow `33`, which many palettes render orange-brown.

## Site tokens

[`theme/theme.css`](theme/theme.css) carries this page's palette, type, and
marker and size classes for the quest log site in `cloudflare/`, and
`theme/icon.svg` is its app icon, the mark on a full-bleed square for home
screens to mask, exported as `theme/icon-180.png`, `theme/icon-192.png`, and
`theme/icon-512.png` (`rsvg-convert -w 512 -h 512 icon.svg -o icon-512.png`).
Change this page first, then that file.

## Mark

[`theme/logo.svg`](theme/logo.svg) is a flat slate `!` on an amber rounded
square, its dot drawn as a ring: a commit node, so the mark reads both as a
quest ready to start and as Git history. It carries its own fill, so it reads
on light and dark pages. From 32 px up the ring shows; at 16 px it closes into
a plain dot and the mark is still a `!`. Use it as is: do not recolour it, add
text inside it, or pair it with game art. Beside it, the name is set as
"Quest" in the page's heading face, never inside the square.

## On moq-dev's sites

The quest log site (`cloudflare/`) sits beside moq.dev, so it wears moq-dev's
house scheme for everything that isn't Quest's own: the slate surfaces, ink,
Signal Green accent, and type of moq-dev/moq.dev's `src/layouts/global.css`.

| Token | Hex | Use |
| --- | --- | --- |
| bg | `#0f172a` | Page |
| surface | `#131d33` | Panels and entries |
| surface-2 | `#1a2540` | Raised controls |
| line | `#1f2a42` | Hairlines |
| line-strong | `#2c3a57` | Hover and emphasis |
| ink | `#eef2f8` | Headings and titles |
| ink-2 | `#c4cddc` | Body text |
| ink-3 | `#8c99b0` | Secondary text |
| accent | `#22c55e` | Primary buttons, focus |
| accent-ink | `#4ade80` | Links and labels |

Type is one family, Atkinson Hyperlegible Next, with Atkinson Hyperlegible
Mono for identifiers such as branches, commits, and paths. It was drawn for
legibility and tells `I`, `l`, `1` and `0`, `O` apart, which a log of PR
numbers and hashes read on a phone needs. Hierarchy comes from size and weight,
in sentence case: no capitals or tracking for labels. Both faces are
open-licensed and served by the site. Quest's markers, size colours, and mark stay as above: the amber `!`
and `?`, the rarity ladder with its labels, and the amber square.

## MoQ branding

The site footer and share card use the
[official moq.dev wordmark](https://github.com/moq-dev/moq.dev/blob/77d39e45682b8896476e325e94b024974d28efd8/public/home/logo.svg).
The [MIT notice](theme/moq-dev-license.txt) ships with the file, and covers
copyright in the SVG; it grants no right to use moq.dev's mark. That needs the
moq.dev maintainer's (Luke's) written permission, which this fork doesn't have
yet: ask before this lands, and record the permission here.
Quest's own mark continues to identify the app in the header and on home
screens. On the share card the wordmark follows "from", so the card says where
Quest comes from rather than reading as a MoQ product.

## Social image

The landing page uses [an original route map](theme/route.svg). The amber line
connects commit nodes and branches across slate contours. The board beneath
it explains the real dependency using text and labeled statuses.

The [social card](theme/og.svg) pairs the map with the mark and headline.
Both the README and the site use its 1280 × 640 PNG. From the repository
root, install the locked dependencies for Atkinson and render locally:

```sh
google-chrome --headless=new --allow-file-access-from-files --hide-scrollbars \
  --virtual-time-budget=5000 --window-size=1280,640 \
  --screenshot="$PWD/design/theme/og.png" "file://$PWD/design/theme/og.svg"
```

The repository owner can also select this PNG under Settings → General →
Social preview.

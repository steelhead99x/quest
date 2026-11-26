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

Hook, then substance. Lead with "a quest log for your repo and your agents",
then deliver the pitch: readable plans, explicit dependencies, and reviewable
Git changes.

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
`theme/icon-192.png` and `theme/icon-512.png` are its home-screen icons.
Change this page first, then that file.

## Mark

[`theme/logo.svg`](theme/logo.svg) is a flat dark `!` on an amber rounded
square. It carries its own fill, so it reads on light and dark pages, and it
stays legible at 16 px. Use it as is: do not recolour it, add text inside it,
or pair it with game art.

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

Headings use Bricolage Grotesque, bold, in sentence case; body text uses DM
Sans; labels and figures use DM Mono. All three are open-licensed and served by
the site. Quest's markers, size colours, and mark stay as above: the amber `!`
and `?`, the rarity ladder with its labels, and the amber square.

## Social image

[`theme/og.svg`](theme/og.svg) is the source and
[`theme/og.png`](theme/og.png) the 1280 by 640 export. The SVG imports
Barlow Condensed and Inter from Google Fonts, so export it with network
access. Headless Chrome can silently fall back to system fonts on a cold font
cache, so re-run the export if the fonts look wrong:

```sh
google-chrome --headless=new --hide-scrollbars --virtual-time-budget=10000 \
  --window-size=1280,640 --screenshot=design/theme/og.png \
  "file://$PWD/design/theme/og.svg"
```

A maintainer uploads `og.png` by hand under the repository's Settings, General,
Social preview.

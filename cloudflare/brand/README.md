# Kixel Quest brand

Kixel Quest is this site's name: Quest, moq.dev's open-source quest log, run
by [Kixel](https://kixel.ai/). Every file here is hand-written SVG or a PNG
exported from one with `rsvg-convert`.

## Mark

`logo.svg` is Kixel's mark, a K of five amber cells on a graphite tile, with
the cell that ends the K's leg drawn as Quest's commit node. Kixel's other
apps use the same system with their own glyph in that cell (RindBench: a
forward chevron). Don't redraw the K's five cells.

- `icon-180.png`, `icon-192.png`, `icon-512.png`: `logo.svg` at that size.
- `icon-maskable.svg` and its PNGs: full-bleed graphite with the cells scaled
  to 78% so they stay inside a maskable icon's safe circle.

```sh
for s in 180 192 512; do rsvg-convert -w $s -h $s logo.svg -o icon-$s.png; done
for s in 192 512; do rsvg-convert -w $s -h $s icon-maskable.svg -o icon-maskable-$s.png; done
```

## Colour

| Role                              | Hex       |
| --------------------------------- | --------- |
| Graphite, the page                | `#07090d` |
| Panel                             | `#0d1118` |
| Raised                            | `#121820` |
| Rule                              | `#1b2430` |
| Ink                               | `#e7ecf2` |
| Muted ink                         | `#8b96a5` |
| Kixel amber, the one brand colour | `#ffb020` |
| Amber for links                   | `#ffc65a` |

Kixel amber marks the brand, primary actions, links, and Quest's ready `!` and
in-review `?`. The size colours stay Quest's (design/theme.md).

## Type

Atkinson Hyperlegible Next, with its Mono for identifiers (src/site.css).

## Social image and hero

`og.svg` → `og.png` (1280 × 640) is the link preview. Rendering it needs
Atkinson Hyperlegible Next installed as a system font, at weight 700.
`route.svg` is design/theme/route.svg in Kixel's colours, ending at the mark.

```sh
rsvg-convert -w 1280 -h 640 og.svg -o og.png
```

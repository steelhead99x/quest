# [S] Pixel theme for the mobile apps

## Goal

`design/theme.md` gains a mobile section that both apps implement
identically: an 8-bit presentation on the existing size colours and
markers. Headings use an open-licensed pixel display font, panels have
2 px frames and hard offset drop shadows, buttons press down into their
shadow, and the `!` mark is redrawn as a pixel sprite from `logo.svg`.
Body text stays in the system font so it follows Dynamic Type and
Android's font scale.

## Plan

- Recommended font: Silkscreen, under the SIL Open Font License, bundled
  with its licence file in each app. Pixel fonts are headings and short
  labels only; anything longer than a line uses the system font.
- Sprites are drawn cell by cell from a text grid shared by both apps, so
  they stay crisp at any scale, with no image files to keep in step.
- Keep every existing rule: colour is never the only signal, so each size
  colour sits beside its label and each marker beside its state; no XP,
  levels, achievements, or leaderboards; no names, art, or fonts from any
  game.
- Light and dark palettes, each meeting WCAG AA contrast for text, with
  the size colours checked against both backgrounds.

## Waiting

- Maintainer: allow pixel art on mobile. `design/theme.md`'s Voice
  section says "no pixel art or sound". Options: allow pixel styling in
  the mobile apps only, recorded as an exception in the theme
  (recommended, since the CLI and docs keep the plain look); allow it
  everywhere; keep the plain theme on mobile too, which drops the 8-bit
  goal. An agent cannot settle this because it changes a rule the
  maintainer wrote.

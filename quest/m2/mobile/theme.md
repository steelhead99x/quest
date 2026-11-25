# [S] Mobile theme

## Goal

`design/theme.md` gains a mobile section that both apps implement
identically, applying the existing quest log theme to native screens: the
size colours beside their labels, the amber `!` and `?` markers and grey
blocked `!`, and `logo.svg` as the app icon. It names the fonts, spacing,
and light and dark palettes, so the Android and iOS apps look the same
without sharing code.

## Plan

Decided 2026-11-25 (contributor): no pixel art, following the theme's
Voice section ("no pixel art or sound"). The fork's first plan proposed an
8-bit look, with a pixel display font, pixel frames, and sprites; it was
dropped before review, so no maintainer decision is needed.

- Recommended fonts: the theme's Barlow Condensed for headings and the
  system font for body text, so body text follows Dynamic Type and
  Android's font scale. Both are open-licensed; bundle Barlow Condensed
  with its licence file in each app.
- Keep every existing rule: modern game UI, not fantasy pastiche; colour
  is never the only signal; no XP, levels, achievements, or leaderboards;
  no names, art, or fonts from any game.
- Light and dark palettes, each meeting WCAG AA contrast for text, with
  the size colours and accent checked against both backgrounds.
- The icon uses `logo.svg` as is, as the Mark section requires, exported
  at each platform's sizes.

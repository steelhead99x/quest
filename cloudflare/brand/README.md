# Brand assets for the quest log site

The site's own social image. Quest's mark, app icons, and the repository's
social preview live in [`design/theme/`](../../design/theme); `design/theme.md`
is the source of truth for both.

- `og.svg` is the source and `og.png` the 1280 by 640 export the site serves at
  `/og.png` (`scripts/build.ts` copies it). It draws the mark, the hook and
  pitch from `design/theme.md`'s Voice, and the board's sample quests: a ready
  quest joined to the one it unblocks, and one in review.
- It reads Atkinson Hyperlegible Next from `node_modules`, so run
  `bun install` first, then export from this directory:

```sh
google-chrome --headless=new --hide-scrollbars --virtual-time-budget=5000 \
  --window-size=1280,640 --screenshot="$PWD/og.png" "file://$PWD/og.svg"
```

Check the export: on a cold font cache headless Chrome can fall back to a
system font. Re-run it if the headline isn't in Atkinson.

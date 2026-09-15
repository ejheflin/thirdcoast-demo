# Display fonts — bundled, never linked

`Archivo Black` (display) and `Barlow Condensed` 500/600/700 (body), as local
WOFF2. 8 files, ~139 KB, latin + latin-ext only.

## Why these are committed

Handoff §2 names this exact failure: a Google Fonts `<link>` works perfectly on
a dev machine and renders the entire board in Times New Roman at the venue,
because the box has no uplink. The prototype review sheets still use the CDN —
they are read on a laptop and never leave one. **Anything that goes on the TV
loads `fonts.css`.**

## Regenerating

```bash
node prototype/fonts/refresh-fonts.mjs
```

Needs network. Edit `QUERY` in that script to change families or weights;
`fonts.css` is generated from whatever comes back and should never be
hand-edited.

## Two decisions worth knowing

**`font-display: block`, not `swap`.** Swap is right for the web — show
something immediately, upgrade when the real face lands. On an unattended TV
that nobody is standing in front of, a flash from Arial to Archivo Black is
just a glitch in an empty room. Block waits.

**latin + latin-ext, no vietnamese.** Google serves three subsets; team names
and captain names in the real LeagueApps data are latin, and latin-ext covers
accented names if one turns up. Dropping vietnamese saves about a third of the
bytes. If a team name ever renders as boxes, that is the thing to revisit.

## For the production build

These are the files to embed with `go:embed` when `/display` is built. The
served page should reference them at a path the binary owns — the current
relative `url('...woff2')` in `fonts.css` works because the prototype and the
fonts sit in one folder, and that will need rewriting when it moves.

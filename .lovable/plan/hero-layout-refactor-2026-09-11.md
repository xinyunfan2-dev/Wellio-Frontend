# Hero Layout Refactor

## Goal
Reduce text, move content up, and restructure stats to sit horizontally alongside the "Wellio" title with vertical dividers — matching the reference image's column format but in Wellio's green palette (no red/yellow/green).

## Changes to `src/components/concept/Hero.tsx`

### 1. Horizontal stats row aligned with Wellio title
- Replace the current stacked `<dl>` in the top-right header with a horizontal 3-column row
- Each column: large mono number + small uppercase label, separated by thin vertical `border-rule` dividers (like the reference image)
- Position this row on the same baseline as the "Wellio" h1 — flex row, `items-end` or `items-baseline`, title on left, stats on right

### 2. Reduce text
- Keep: "Wellio" title, definition line ("A fitness agent that reads your world and re-plans the moment reality changes." with highlight on "agent")
- Shorten the body paragraph to one concise sentence instead of the current long one, e.g.:
  > The rack is taken, you have 35 minutes, and dinner is somewhere new. Wellio reads the room and re-plans on the spot.

### 3. Move everything up
- Reduce top padding (`pt-10` → `pt-8` or less)
- Change the content container from `flex-1 items-start pt-10` to less padding so text sits higher

### 4. Colors
- Stats use `text-ink` for numbers, `text-ink-soft` for labels, `border-rule` for dividers — all existing Wellio palette tokens, no red/yellow/green

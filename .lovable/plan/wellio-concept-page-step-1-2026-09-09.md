# Wellio — Concept Page, Step 1

First a single large opening screen so you can judge the look. The rest of the concept story comes after you approve the direction.

## Visual direction

"Sports-science lab report." Light and precise, not wellness-soft.

- Warm off-white paper background, ink-black text, one signal color (electric lime-green) reserved for agent output and live adaptation
- Faint measurement grid in the background; hairline rules
- Geometric sans for headings with tight tracking; monospace for data, numbers, and tool names
- Sharp corners, thin 1px borders, no drop shadows, no gradient blobs
- Restrained motion: a quiet fade-up on load

## What gets built now

One full-height opening screen (English), at `/`:

- Small monospace eyebrow: WELLIO / CONTEXT-AWARE FITNESS AGENT
- Headline: plans break the moment you walk into the gym
- One-sentence subhead: Wellio remembers your goal, your gym's equipment, and what you've eaten today — and re-plans on the spot
- A "context ledger" panel in monospace showing live state: goal, gym, time left, calories so far, protein remaining
- Three stat markers along the bottom: 17 agent tools, 5 demo scenarios, 2 live adaptations
- A quiet scroll cue hinting the story continues

No navigation bar, no second CTA, no card grid — just the statement and the ledger.

## After you approve the look

The remaining sections follow in a second pass: the four problems, five scenario walkthroughs (with the two adaptation moments highlighted), technical highlights (agent loop, tool groups, stack), and the scope boundaries — all drawn from your document, nothing invented.

## Technical notes

- Replaces the template placeholder at `src/routes/index.tsx`; screen split into components under `src/components/concept/`
- Tokens (paper, ink, signal, grid) defined in `src/styles.css` as semantic variables — no hardcoded colors
- Fonts loaded via `<link>` in the root route head
- Route `head()` with Wellio-specific title, description, OG and Twitter tags; single H1
- `prefers-reduced-motion` respected

## Open question

Do you have a demo video URL yet? If not, the later closing section will use a placeholder frame you can swap in.

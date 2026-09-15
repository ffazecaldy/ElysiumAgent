---
name: living-dashboard
description: Use when building living dashboards or animated landings.
---

# Living Dashboard

Build polished single-file HTML experiences that feel alive — breathing, reactive to the cursor, with magnetic cards, ambient light, and restrained high-end motion. Supports both compact operational dashboards and long-form product storytelling landings (the style that produced high-quality results like METRIA).

**Triggers**: dark/light interactive dashboards, product UIs, metrics UIs, model intelligence pages, cybernetic interfaces, animated product landings, PropTech/FinTech sites, reactive cursor, magnetic cards, breathing elements, ambient light, presence, organic micro-interactions, "full living animation levels".

## Required Intake (Always Ask First)

Never generate until you have (or the user has explicitly provided) answers to the following. If the user gives a dense brief, extract what you can and ask only for the missing critical pieces. Prefer short confirmation over long interrogation.

### 1. Theme & Visual Direction
- **Theme**: dark | light | mixed sections
- **Mood** (one or more): architectural · financial/investment · PropTech · minimal/premium · editorial · cinematic · tech · luxury · raw
- **References** (optional but powerful): Raycast, Linear, Vercel, Stripe, Apple, Ramp, Arc, etc.

### 2. Palette
Ask for primary / accent / secondary hex values, or a short vibe description.
Offer starting points only if the user asks: navy + terracotta + petrol green · emerald + indigo · warm orange/gold · pure grayscale · pink/violet · sky/cyan.

For light theme invert surfaces while keeping the same accent hues.

### 3. Brand & Positioning
- Product / company name (or ask the agent to invent one)
- Naming criteria if inventing: Italianate or clean European, conveys precision / measurement / risk control / data reliability. Avoid vague, hype, or risky-sounding names.
- Core positioning / tagline (example: "Il sistema operativo dell'investitore immobiliare.")

### 4. Hero Type
Choose one primary approach:
- **A — Product-first**: large title + product UI
- **B — Editorial**: magazine-like with strong imagery
- **C — Data-first**: analysis card / metrics dominate the first screen
- **D — Cinematic**: spectacular image + UI emerging
- **E — Minimal**: giant title, almost nothing else

### 5. Content Intent & Length
- Compact operational dashboard (dense metrics, 1–2 screens)
- Medium product page (~6–9 sections)
- Full storytelling landing (10–15 sections, Apple/Linear depth)
- Must-include modules (tick what applies): before/after transformation, ROI scenarios, professionals roster with small photos, savings metrics, report mockup, pricing, FAQ, live analysis card, market engine explanation

### 6. Copy & Tone
- Language: Italian / English / mixed
- Tone: direct + investor (money & time) · premium · technical · editorial · provocative
- AI visibility: **invisible** (preferred for trust) | evident | futuristic. Never over-push "AI" if the audience distrusts it.

### 7. Animation Level
- **0** — static / polished transitions only
- **50** — moderate (idle float, hover lift, soft glows, bar entrances, staggered reveals)
- **full** — living organism (custom cursor + ring, particles or orbs, magnetic tilt, ambient mouse-following glows, breathing borders, click ripple)
- Combinations allowed (e.g. "smooth + cursor + breathing")

### 8. Visual Assets
- Photography style: realistic real-estate · architectural · editorial · none (UI only)
- Prefer real Unsplash / high-quality placeholders over abstract shapes when storytelling is involved.

If the user already gave a dense brief (as in the METRIA example), map it to the points above and confirm only the ambiguities before coding.

## Output Rules

- Deliver **one self-contained .html file** (no build step, no external CSS/JS beyond Google Fonts).
- Prefer fonts: Inter + Instrument Serif + JetBrains Mono / DM Mono (or close equivalents already proven in high-quality results).
- Write the file to the workspace artifacts dir unless the user specifies otherwise.
- After generating, give a short summary of theme, animation level and key modules included.

## Design Inspiration & Anti-Slop (Critical)

Primary references (study the craft, do not copy):

- **Raycast** — dramatic controlled lighting, floating refined panels, excellent hierarchy, generous breathing room mixed with dense useful UI.
- **Linear** — extremely refined dark surfaces, almost invisible soft borders, perfect card nesting and elevation, mature information density, purposeful minimal motion.
- **Vercel / Stripe** — clean product storytelling, strong typography scale, restrained accent color.

### Rules to avoid generic AI dashboard look

- Soft, near-invisible borders and layered translucent surfaces over thick glowing outlines.
- Real depth (subtle shadows + backdrop-filter) instead of neon glow spam.
- Intentional typography hierarchy: clear scale, excellent tracking/leading.
- Cards and panels feel nested and crafted, not floating randomly.
- Motion must feel physical and restrained (Linear/Raycast level). Never playful, bouncy or over-animated.
- Information density is allowed and often preferred for operational tools.
- Color accents precise and sparse.
- Overall feeling: "expensive product tool" or "high-end investment OS", never "AI-generated cyber dashboard".

## Architecture (Always Follow)

### CSS Variables (Required)

```css
:root {
  --bg: ...;
  --surface: ...;
  --surface-2: ...;
  --border: ...;
  --border-top: ...;
  --primary: ...;
  --accent: ...;
  --secondary: ...;
  --text: ...;
  --text2: ...;
  --muted: ...;
  --success: ...;
  --warm: ...; /* optional cream/off-white */
  --ease: cubic-bezier(0.16, 1, 0.3, 1);
  --mouse-x: 50%;
  --mouse-y: 50%;
  --max: 1240px; /* or 1180px for denser */
}
```

Dark defaults — deep near-black/navy bg, near-transparent white surfaces, cream or off-white text.

Light defaults — warm off-white bg, white/translucent surfaces, near-black text.

### Recommended Section Order for Full Storytelling Landings

1. Sticky nav (brand + links + CTA)
2. Hero (chosen type) + live analysis / product card
3. Proof / KPI strip
4. Method / Before-After cinematic block
5. Market / Intelligence engine (3 cards)
6. ROI + scenarios
7. Professionals network (photos + costs)
8. Report / thesis mockup
9. Pricing
10. FAQ
11. Final CTA
12. Footer

For compact dashboards, collapse to: Header → Hero/KPIs → Main grid → Stats → Roster → Footer.

## Animation Levels — Exact Behaviour

See references/animation-levels.md for the definitive list.

Level **full** (living) must include:

- Custom snappy cursor (dot + optional ring)
- `cursor: none` on body (respect prefers-reduced-motion)
- Mouse-following ambient glows or soft orbs
- Magnetic + gentle 3D tilt on key cards (no aggressive scale)
- Breathing borders or soft pulse on winner elements
- Floating particles or very subtle rising dots (optional, low opacity)
- Click ripple
- Idle float only via translateY(±2px) — never scale on idle
- Pause idle animations on hover

## Critical Quality Rules (Avoid Glitches)

- Cursor must be snappy — set left/top directly from mousemove, no lerp lag.
- Never randomly scale numbers or cards on a timer.
- Idle animations use only translateY (2px max).
- On hover pause idle animation so transforms do not fight.
- Live dots and eyebrow bullets are static unless the user explicitly asks for pulse.
- Presence / whisper box is off by default.
- Avoid scale() on hover for large cards; prefer translateY + shadow.
- Always respect prefers-reduced-motion: reduce.

## Interaction Patterns (Full Level)

```javascript
// Snappy cursor + CSS variables
document.addEventListener('mousemove', (e) => {
  cursor.style.left = e.clientX + 'px';
  cursor.style.top = e.clientY + 'px';
  document.documentElement.style.setProperty('--mouse-x', e.clientX + 'px');
  document.documentElement.style.setProperty('--mouse-y', e.clientY + 'px');
});

// Magnetic tilt (no scale)
card.addEventListener('pointermove', (e) => {
  const r = card.getBoundingClientRect();
  const x = (e.clientX - r.left) / r.width - 0.5;
  const y = (e.clientY - r.top) / r.height - 0.5;
  card.style.transform =
    `translateY(-4px) translate(${x*5}px, ${y*5}px) rotateX(${-y*6}deg) rotateY(${x*6}deg)`;
});
card.addEventListener('pointerleave', () => { card.style.transform = ''; });
```

## Content & Copy Principles (Especially for Investor / PropTech)

- Speak the language of money and time. No fluff.
- Prefer ranges and scenarios over false precision ("€46–61K", "14–22% ROI").
- Before/After must show both visual transformation and clear economic delta.
- Professionals section: small photos + role + indicative cost range.
- AI is the engine, not the headline. Push reliability, control of risk, and speed of decision.
- Every major claim should be backed by a visible number or comparison.

## Workflow

1. Run the Required Intake (or map a dense user brief onto it). Confirm missing pieces.
2. Decide: compact dashboard vs full storytelling landing.
3. Invent or confirm name + tagline if needed (precision > cleverness).
4. Generate the complete single HTML file following the architecture and anti-slop rules.
5. Write to the artifacts dir.
6. Briefly list theme, animation level, and key modules included.

## Reference Files

- references/animation-levels.md — definitive behaviour for levels 0 / 50 / full.

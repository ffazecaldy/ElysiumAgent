# Animation level details

## Level 0 — Static

- Only essential CSS transitions on hover (border-color, background, box-shadow)
- No keyframes
- No JavaScript motion systems
- Default system cursor
- Clean, professional, zero distraction

## Level 50 — Moderate

Include:

- fadeUp / fadeDown entrance animations with staggered delays
- Soft `panelBreathe` on main panels (border-color only)
- `champIdle` translateY ±2px on KPI cards and stat cards
- Bar tracks that scaleY from 0 on load
- Sentiment / progress bars that grow width
- Segmented control sliding pill
- Hover lift via translateY(-3/-4px) + stronger shadow
- Pause idle animation on hover

Exclude:

- Custom cursor
- Particles / orbs
- Magnetic / 3D tilt
- Mouse-following glows
- Presence / whisper box
- Click ripple

## Level full — Living

Everything from level 50 plus:

### Cursor
- Custom snappy dot (optionally + ring)
- `cursor: none` on body
- Position set directly from mousemove (no lag / no trail)
- Grows slightly on interactive hover, shrinks on click
- Always respect `prefers-reduced-motion: reduce` (fall back to system cursor)

### Atmosphere
- 2–3 ambient radial glows or soft orbs that shift with mouse / drift slowly
- Optional very low-opacity floating particles that rise slowly
- Optional soft mouse spotlight
- Optional film grain overlay at very low opacity

### Cards & Panels
- Magnetic pull toward cursor + gentle rotateX/Y (max ~6deg)
- Never combine scale with idle translate (causes jumps)
- Winner / featured elements may have soft infinite glow pulse or breathing border
- Idle float only via translateY (±2px max)

### Presence
- Corner whisper box is *disabled by default*
- Only add if the user explicitly requests "presence", "whisper", or "talking UI"

### Click
- Small ripple at pointer position

### Additional Quality Rules
- On hover pause any idle animation (`animation-play-state: paused`)
- Prefer translateY + box-shadow over scale for large cards
- Live status dots are static unless user asks for pulse
- All motion must feel physical and restrained (Linear / Raycast level)

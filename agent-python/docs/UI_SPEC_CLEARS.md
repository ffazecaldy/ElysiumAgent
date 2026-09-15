# Elysium Agent — UI spec stile ⚡ clears.ai

Obiettivo: replicare il linguaggio visivo di **clears.ai** nell'harness
(chat + progetti + loop multi-agente). Pulito, premium, figtree, light+dark
con accent lilla e glow marcato. In italiano, futuristica e armoniosa.

## Design tokens (vincolanti)

### Tipografia
- Font: **Figtree** (Google Fonts) — sostituisce Space Grotesk.
- Base 15-16px, line-height 1.5-1.6.
- Headline hero: clamp(34px, 5vw, 72px), weight 600, tracking -0.02em.
- Uppercase label (kicker): 11-12px, weight 500, letter-spacing 0.08-0.14em,
  color muted.
- Numeri smart format (1.5k / 1.2M / 8.25) — invariato.

### Colori
```
light:
  --bg:        #ffffff
  --surface:   #fafafa
  --surface2:  #f2f2f3
  --border:    #e1e1e1
  --text:      #171717
  --muted:     #737373
  --accent:    #bf8dff            (lilla brand)
  --accent-hi: #caa2ff
  --success:   #16a34a
  --warn:      #d97706
  --danger:    #dc2626

dark (zones hero/Chat ecc.):
  --bg:        #0a0a0a
  --surface:   #101010
  --surface2:  #171717
  --border:    #262626
  --text:      #f5f5f5
  --muted:     #a1a1a1
  --accent:    #bf8dff
```

### Glow & ombre (firma clears.ai)
- Glow accent: `0 0 28px rgba(191,141,255,0.18)`
- Glow forte:  `0 0 32px rgba(191,141,255,0.28)`
- Glow soft:   `0 0 55px rgba(191,141,255,0.08)`
- Ombra card light: `0 1px 2px rgba(0,0,0,.05)`
- Massimo 1-2 livelli di shadow (niente spam).

### Radii e bordi
- Card: 12px | pill/tag: 999px | input/button: 8-10px.
- Bordo 1px `var(--border)`. Focus ring accent 2px.

## Componenti

1. **Topbar**: sticky, light, border-bottom `#e1e1e1`, logo-testo nero
   "+ ELYSIUM", nav uppercase tracking (CHAT / RUN), pulsanti "NUOVO
   PROGETTO" (primary dark) e stato online/offline (pill).
2. **Hero header progetto** (solo con progetto attivo): nome grande,
   kicker "PROGETTO", pill tier, metriche in pill (N file · N run).
3. **Board-like sidebar**: lista progetti → card sottili con dot accent
   glow, nome, n file; CTA "+ NUOVO PROGETTO" con glow lilla.
4. **Chat**: bolla utente = accent-tinted (bg `#f3ebff`, border `#e4d5ff`),
   bolla elysium = white/`#fafafa` con border `#e1e1e1`.
   Report del loop = **card scura `#0a0a0a` con testo chiaro e glow accent**
   (firma clears.ai: dark card su light page), con pill final_status colorati.
5. **File browser** e **vista RUN**: card light, header uppercase tracking,
   righe con hover, detail drawer scuro con glow.
6. **Footer**: piccolo, muted, "Elysium Agent — harness multi-agente".

## Stati obbligatori
- Loading: spinner accent. Empty: messaggio + CTA. Error: banner rosso sottile.
- aria-label su ogni bottona icona; focus visibile; contrasto AA.

## Anti-slop
- Zero gradiente generico (max il glow).
- ≤2 ombre totali.
- Figtree dappertutto; niente placeholder/lorem.

## File da toccare
- `web/index.html`, `web/app.js`, `web/style.css` (SU UNICO commit, si toccano insieme)

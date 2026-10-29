# Design rules — binding for `frontend/`

Distilled from Apple's WWDC sessions *Designing Fluid Interfaces* (2018), *The Details of UI Typography* (2020) and the Human Interface Guidelines.

1. Respond on pointer-down; never wait for click. `:active` scale 0.97, 100 ms.
2. Anything draggable tracks 1:1 with Pointer Events + `setPointerCapture`; respect grab offset.
3. Every animation interruptible. Springs (damping 1.0 default, 0.8 only after momentum). No CSS keyframes on gesture-driven UI.
4. Spatial consistency: sheets enter/exit along same edge; popovers scale from trigger (`transform-origin`).
5. Rubber-band at boundaries; never hard-stop.
6. Translucent chrome: `backdrop-filter: blur(20px) saturate(180%)`; content scrolls under. Never stack two light materials.
7. Typography: system font; large text negative tracking (-0.02em), body 0; leading tight on headings, 1.5 on body. Sizes in rem.
8. Light + dark palettes as tokens; ease theme changes.
9. `prefers-reduced-motion` → cross-fades. `prefers-reduced-transparency` → solid. `prefers-contrast` → borders.
10. Feedback kinds: status, completion, warning, error. Validate inline. Confirm only destructive.
11. Wayfinding: device state always visible. Specific labels ("Set Location", not "Go").
12. Simplicity ≠ minimalism: common path first (map → pin → Set), advanced (GPX, favourites) one level deeper.
13. Craft: every spacing value on 4 px grid; 8 px radius small, 12 px controls, 20 px cards.

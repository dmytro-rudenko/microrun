# login — prototype decision

**Chosen:** variant B3 (`variants/b3/index.html`) — narrow dark console panel (server with dev/stage/prod, live deploy log, tagline) and an open form area on the right.
**Why:** it reads as a tool for operators, matches the board's monospace/status vocabulary, and the form stays plain enough to share one input style with settings.
**Changed while debugging:**
- the error block was visible on load: Tailwind's `flex` beat the `hidden` attribute. Rule for the product: a hidden block either is not rendered by the server or gets its `display` only under `:not([hidden])`;
- the commit hash on the dev row overlapped the status LEDs — branch left, hash right-aligned before the LEDs;
- show-password is an SVG icon with a visible focus state, not an emoji;
- the mobile logo mark uses the accent colour;
- English is the default language, and the login page has a language select (English first, all 8 languages); tagline and subline are translated in every catalog.
**Ruled out:** A (50/50 blue diagram) — calmer but generic; C (full-bleed isometric yard) — floating-label inputs would diverge from the settings inputs.
**Open:** the console panel stays dark in the light theme by design; the panel is hidden below 1024px.

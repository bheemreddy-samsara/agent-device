---
'agent-device': patch
---

Make hosted WebDriver `fill` replace existing text by clearing the confirmed focused element before sending replacement text to that same element. An empty replacement clears without typing. A failed clear prevents replacement text from being sent. Unsupported focused-element lookup refuses before tapping; keyboard visibility alone never authorizes a fill. Keep `type` append-only.

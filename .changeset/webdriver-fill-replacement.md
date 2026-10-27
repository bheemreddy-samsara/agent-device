---
'agent-device': patch
---

Make hosted WebDriver `fill` replace existing text by clearing the confirmed focused element before sending replacement text to that same element. An empty replacement clears without typing. A failed clear or an unavailable focused-element reference prevents replacement text from being sent. Keep `type` append-only.

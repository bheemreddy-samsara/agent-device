---
'agent-device': patch
---

Read only the focused element identity before WebDriver fill taps its target. Avoid an unnecessary previous-field rectangle request that can exhaust the focus-probe budget; retain the post-tap identity/geometry checks and existing deadlines.

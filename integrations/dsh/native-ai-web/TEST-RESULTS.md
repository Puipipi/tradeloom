# O06 native AI web ask controller: controlled test evidence

Date: 2026-10-25 (workspace local date)

Command:

```powershell
node --experimental-strip-types --test integrations/dsh/native-ai-web/ask.test.mjs
```

Result: 13 tests passed, 0 failed. Coverage includes FIFO same-site calls,
old-turn/message exclusion, hanging inspect/send deadline behavior, no overlapping
send while a timed-out send is unresolved, immediate queued cancellation,
whitespace draft/attachment preservation and pre-send recheck, first-chunk versus
overall timeout, explicit generation completion, stable answer detection, safe
bounded errors, parameter limits, and answer length limits.

This is a controlled fake-adapter test. It does not exercise Electron, a real
website, authentication, selectors, the send gesture, or production turn-ID
correlation. It is not live-site end-to-end evidence. DeepSeek live/profile was
not accessed. Doubao evidence available to this task confirms only the input
selector and login-button selector documented in `README.md`; no send/answer
selector or actual send was verified.

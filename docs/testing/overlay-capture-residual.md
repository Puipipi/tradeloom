# Overlay capture visibility: verification plan

Status: **not tested**. This change was inspected statically only; no tests,
compilation, build, or device capture was run. The existing CaptureVisibility
unit tests exercise overlapping holds, not actual Android window attachment.

## Device / instrumentation verification still required

Use a test build and a controlled instrumentation harness that can hold the
capture-hidden interval open on the main thread without capturing private user
content. Use synthetic prompt text. For each of shared prompt, legacy confirm,
and legacy handoff:

1. Start a capture hide and keep the hold active; create the card before release.
2. Confirm the newly attached card is INVISIBLE and absent from the resulting
   screenshot; confirm it cannot receive touches while invisible.
3. Release the final hold and confirm the still-pending card becomes visible
   and responds normally to a real user touch.
4. Repeat with two overlapping hide holds, releasing only one first: the card
   must remain hidden until the final release. Also verify the ordinary case
   without a capture displays the card immediately.

Check window attachment and screenshot timing on representative Android
versions and devices. A source-text assertion or a unit test of the hold counter
alone cannot establish the absence of a rendered frame or touch interception.
No such instrumentation harness or device result is claimed by this change.

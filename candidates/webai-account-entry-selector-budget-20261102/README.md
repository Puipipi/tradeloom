# Doubao account-entry selector budget candidate

This isolated variant addresses a false `unknown` result when a navigation contains more than 128 unrelated descendants. The frozen E56FA baseline was copied byte-for-byte to `before/`; its SHA-256 is `E56FA0273869239DC6632CAD3B0ACFE18C6A8664A9089807190883B54AE264A3`.

The Doubao probe now asks each already-validated navigation root for the fixed selector `button[aria-haspopup="menu"]`. It derives the existing controls-linked candidate set from that result using `hasAttribute('aria-controls')`. It no longer walks unrelated navigation descendants. Selector results are deduplicated and capped at 64 across the visible navigation roots; exceeding the cap returns `bounded_unknown`, never a truncated uniqueness claim. Existing navigation-root cap, exact linked-reference checks, multiple-navigation rejection, closed-state checks, DeepSeek fixed-chain logic, and all DTO fields are unchanged.

The fixture adds 256 unrelated navigation rows before exercising open and closed counts. It also puts a second real popup button after those rows and verifies ambiguity, and verifies candidate-set overflow returns unknown. This is a fake DOM regression test, not a real browser or site acceptance result. No live UI or profile was used.

Patch: `fixed-account-entry-probe.patch`. The test imports the new `after/` variant; the original E56FA candidate and its tests remain untouched.

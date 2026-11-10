# DeepSeek fixed-menu positive candidate

This is a new isolated candidate based on the original frozen
`webai-auth-state-20261101` source, SHA-256
`26841E98D9FD1FFC622000B19AC77512295CFB926D939263EEF14AA74BD02413`.
This candidate after module is SHA-256
`A4B048A3D1DA68CCF09422458EDE69B1406C24E70BDD9321F8C53E30AB3F279A`.
It does not use or modify the separate development-reasons candidate. The
original source and the 2154 development candidate remain frozen; the latter
is SHA-256 `2154C6FAA69A544DF9422F48192EEAE7054125776C4D43DFE456FBDCDBB666D1`.

## Positive rule

The only new positive rule is a visible fixed root matching
`[role="menu"].ds-dropdown-menu.ds-elevated` with all four exact visible
semantics inside that same menu:

- 下载手机应用
- 系统设置
- 帮助与反馈
- 退出登录

The evidence supplied for this candidate was a real UI observation from the
frontend owner: DeepSeek's open account menu showed those four items together;
its host sample reported `provider=deepseek`, `generation=5`, all four
allowlisted booleans true, `sameContainer=true`, and a three-level path:
`div[role=menu].ds-dropdown-menu.ds-elevated` →
`div.ds-floating-position-wrapper.ds-theme` → `div.ds-floating-container`. This repository
candidate does not independently inspect that live window or claim a runtime
test. The fixed root selector is derived from that observation.

No trigger, keyboard shortcut, ready state, cookie, URL outside the negative
`/sign_in` rule, or absent login button is positive evidence. The DeepSeek
`/sign_in` negative is checked first and cannot be overridden by a menu result.
Doubao has no positive rule and remains unchanged.

## State behavior

Both `sample()` and `sampleAccountMenu()` use the same private fixed DeepSeek
menu reader and update the same adapter `current` state. The account-menu DTO
shape remains the allowlisted boolean projection. A fresh document starts
unknown and needs a fresh positive observation. A partial, hidden, missing, or
closed menu does not turn a previously observed same-document positive into a
logout claim. A same-document probe execution failure clears current to
unknown. `/sign_in`, document/path identity changes, lifecycle navigation,
process loss, close, and dispose invalidate prior positive state. Late probe
results cannot restore it after generation changes.

The output is only evidence from a visible account menu. It does not prove that
API requests succeed or independently validate the provider's server session.
If a newly opened document has the menu closed and no persistent profile
control is available, status begins unknown until the host performs a read-only
sample while the user-visible menu is open. A later host integration may add a
bounded read-only profile-state probe only after a real positive/negative pair
and stable DOM evidence are observed; this candidate invents no such rule.

## Transfer map

- Strict selector change: `webai-auth-state.js:81`.
- Strict raw DTO validation: `webai-auth-state.js:245-262`.
- Same-document positive predicate/publication and shared fixed reader:
  `:394-447`.
- `sample()` positive/negative/persistence path: `:455-503`.
- `sampleAccountMenu()` publication path: `:505-541`.
- Existing fixed script accessor: `:583` (the function name/export stays the
  same).
- Positive evidence string is added to `WebAiAuthEvidence` in
  `webai-auth-state.d.ts:3`; the adapter interface and menu DTO fields remain
  unchanged.

For host publishing, allowlist the exact value `deepseek-account-menu` only
alongside `authState=authenticated`, `provider=deepseek`, and the current
generation. No new IPC or periodic timer is part of this adapter. The caller
must invoke the existing adapter on the owned WebContents and publish its
current DTO through its already-authorized host path.

## Focused proof and boundary

`recovery-20261029/webai-auth-positive-20261101/testing/` contains copied
synthetic VM fixtures plus the positive, strict-root, partial/hidden,
same-document persistence, negative-precedence, and stale-result cases. Final
result: 28 passed, 0 failed, 0 skipped. These tests prove the adapter rule
against fixtures, not live DOM stability. No installation, live window, user
profile, SDK, frontend, Main, or preload file was changed.

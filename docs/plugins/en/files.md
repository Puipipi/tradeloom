# Selecting files and images

The NA v1.3 `files` capability opens a system chooser after a tap. Selected content goes to the current host, where the plugin reads bytes through a one-shot handle. Selection is the authorization: there is no second permission dialog, writable URI, or phone file path.

## Declaration and fallback

Declare `"capabilities": ["files"]`. Add `"requires": ["files"]` to manifest buttons. Inside a panel, show selection buttons only when `caps.features?.includes('files')`; otherwise show ordinary explanatory text. Older apps and bridges, platforms without a native adapter, and DSH Remote relay connections do not negotiate this capability. Ordinary panels remain available.

File selection does not require view v2. The manifest's `dshGo.v`, HTTP path and WebSocket `v` remain `1`, never `1.3`.

## Start and receive

```js
import { createHash } from 'node:crypto'
import { effects } from '@dsh-go/plugin-kit'

ctx.dshGo.panel('files', {
  view: (scope, caps) => caps.features?.includes('files')
    ? { type: 'actions', items: [{ label: 'Choose files', action: 'choose' }] }
    : { type: 'text', text: 'File selection is unavailable on this connection' },
  actions: {
    choose: () => effects.pickFile('selected', { maxFiles: 2 }),
    selected: async (scope, event) => {
      if (event.value.status !== 'selected') return
      const files = event.value.files.map(file => {
        const bytes = ctx.dshGo.readPickedFile(file.handle)
        return { name: file.name, sha256: createHash('sha256').update(bytes).digest('hex') }
      })
      return { patch: { files } }
    },
  },
})
```

For images, use `effects.pickImage('selected', { maxFiles: 2 })`. Without the SDK, return `{ type: 'pickFile', action: 'selected', maxFiles: 2 }`. `maxFiles` defaults to `1` and accepts integers `1–4`. `action` follows ordinary action-id rules.

The callback runs in the same panel's `actions[action]`. If absent, it falls back to `ctx.dshGo.on(originalContributionId, handler)` with `event.action` distinguishing it. It retains the original `scope`, `surface`, `id` and `locale`, and adds `event.signal`, aborted when this request is revoked. `event.value` is:

```js
{ status: 'selected', files: [
  { handle: 'opaque string', name: 'note.txt', bytes: 12,
    mediaType: 'text/plain', access: 'read' },
] }
// or { status: 'cancelled', files: [] }
// or { status: 'error', files: [] }
```

Names are display labels, stripped of directory components/control characters and limited to 128 characters. MIME is a provider claim, not proof of content. `bytes` is the actual upload length. Cancellation never exposes partly uploaded files; an exceeded budget or failed upload revokes the whole selection. A disconnected or unloaded plugin cannot receive a callback, but its handles are still revoked.

## Handle lifetime

`ctx.dshGo.readPickedFile(handle)` returns an independent `Uint8Array` copy (a Node `Buffer`). It is usable only by its owning plugin **inside this awaited selection callback**, including across `await`. It throws after callback completion, an exception, the existing 3-second handler timeout, plugin unload, registration replacement, disconnection, or request expiry. Other plugins cannot read this handle through the service.

Both the initiating action and its file callback belong to the registrations present when that invoke starts calling the action. Before calling the action, the bridge captures the actual panel action or fallback handler registration and the callback candidates. Replacing either registration while the action awaits rejects its old file effect without allocating a selection slot. Registering a new callback after the action starts cannot attach it to that old invocation. Issued requests continue to track both registrations; disposing either revokes uploads and reads.

For longer work, copy the bytes or `await` persistence into plugin-managed storage inside the callback. Do not save the handle for a later invoke or append `file.name` to a storage path. An importer can use a random name under its own known directory:

```js
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const bytes = ctx.dshGo.readPickedFile(file.handle)
// pluginDataDir is configured and created by the plugin, independent of file.name.
const importedPath = join(pluginDataDir, randomUUID())
await writeFile(importedPath, bytes, { flag: 'wx', mode: 0o600, signal: event.signal })
// The plugin owns its copy's budget, cancellation cleanup and retention policy.
```

Images are bytes too. A handle is not an `image.src`: process a copy during the callback, then follow the existing plugin-resource/data-URI image format and size limits.

Read-only means this path cannot modify the person's original: Android opens with `r`, and the bridge supplies copies. Host Node plugins already share a process. This is not a sandbox against malicious host plugins and does not constrain storage they create from their own copies.

## Gestures and cleanup

A chooser must come from the direct invoke of a fresh tap, reaching the app within the existing 3-second window. Static effects, background data, deferred results and `onChange` cannot open one. The app supplies `userGesture: true`; bridge and native checks enforce the boundary. Authors cannot supply authority fields such as `request`.

The chooser can take longer. Its callback accepts only `patch`, `refresh` and `toast`; it cannot open another chooser, write the clipboard, run a command or create a deferred effect. Another selection needs another tap.

There is one selection flow across the entire app. Host switches, unavailable plugins, disconnection, Activity destruction and expiry cancel reads. Android closes cursors and input streams on workers and discards late results. While this explicit system chooser is open, the normal background disconnect grace is extended only for this bounded request, then restored.

After ten seconds without new bytes, the app first sends native cancellation for this request's original owner, then cancels the source subscription and completes the flow with an error. It does not wait for a stalled provider read before sending cancellation. Partial bytes are never delivered as selected, and late data cannot cancel a new selection. If a native worker still has not returned, `ioBusy` / `closing` continues to reject a new chooser; finishing the app flow does not mean Android can forcibly terminate an uncooperative content provider.

## Fixed budgets

| Item | Limit | Reason |
|---|---:|---|
| Files | Requested `1–4` | Small batch per tap; checked by all three receiving layers |
| Per file | 8 MiB | One bounded upload buffer in the app |
| Per selection | 16 MiB | Two full-sized or four smaller files; bounded mobile upload cost |
| Retained bridge content buffers | 64 MiB across the host | Shared by all connections; unknown lengths reserve capacity first |
| Outstanding bridge requests | 8 per host, 1 per connection | Waiting requests are bounded too |
| Native chunk | 64 KiB | No unbounded whole-file copy before returning to Dart |
| Request lifetime | 5 minutes | Selection, upload and callback share one finite lease |
| Upload | 30 seconds each | Slow connections fail; a new tap can retry |
| Read without progress | 10 seconds | A broken provider cannot retain the app flow indefinitely |
| Callback | Existing 3 seconds | Copy first; report long-running work through existing data feeds |

These are resource policies, not measured performance claims. Known lengths and count are checked before upload. Unknown, negative or dishonest size metadata cannot bypass actual byte counting in native code, Dart and the bridge. No partial success is delivered. Provider/system internals may have their own resources; these budgets cover buffers allocated and retained by this implementation.

## Android and remote hosts

- Files use `ACTION_OPEN_DOCUMENT`, `CATEGORY_OPENABLE` and `*/*`; this app's minimum Android version is 26.
- Images use `MediaStore.ACTION_PICK_IMAGES` from Android 33. Multiple selection uses the lesser of the requested count and `getPickImagesMaxLimit()`. Older systems or a missing Photo Picker Activity fall back to `ACTION_OPEN_DOCUMENT` with `image/*`.
- Only temporary read access is requested: no directory, write or additional storage permission, and no `takePersistableUriPermission`. Reads use `ContentResolver.openAssetFileDescriptor(uri, "r", ...)` with `CancellationSignal`, bypassing the dependency path that first copies the entire file to cache.
- Local and direct SSH hosts reuse existing host authentication, HTTP carriers and SSH tunnels. Uploads use our own `/dsh-go/v1/files/` bridge route without changing the DSH engine protocol. Existing `fileUploads/upload` returns conversation attachment receipts, not a plugin-readable path.
- DSH Remote relay does not currently forward `/dsh-go/*`; `files` stays unavailable. It cannot open a chooser and falsely report delivery. Authenticated bridge-route forwarding is an upstream prerequisite.

Android references: [Storage Access Framework](https://developer.android.com/training/data-storage/shared/documents-files), [MediaStore Photo Picker](https://developer.android.com/reference/android/provider/MediaStore#ACTION_PICK_IMAGES), and [ContentResolver](https://developer.android.com/reference/android/content/ContentResolver#openAssetFileDescriptor(android.net.Uri,java.lang.String,android.os.CancellationSignal)). This change has API-jar compilation and cross-layer automated tests; system UI, vendor providers, process recreation and a real SSH device path still require device verification.

Runnable example: [`dsh-go-example-files`](../../../examples/plugins/dsh-go-example-files/) computes SHA-256 from actual selected bytes. It never automatically attaches files to a conversation or calls a model.

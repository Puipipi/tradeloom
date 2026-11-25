import { effects, checkEffects, type Capability, type DshGoService, type FileSelection, type InvokePickImage } from '../../types/index.js'
import { createTestHost } from '../../types/testing.js'

const feature: Capability = 'files'
const effect: InvokePickImage = effects.pickImage('selected', { maxFiles: 4 })
checkEffects(effect, { userGesture: true, capabilities: { declared: [feature], features: [feature] } })
declare const service: DshGoService
declare const result: FileSelection
if (result.status === 'selected') {
  const copy: Uint8Array = service.readPickedFile(result.files[0].handle)
  const readOnly: 'read' = result.files[0].access
  void copy; void readOnly
}
// @ts-expect-error counts are numbers, never numeric strings
effects.pickFile('selected', { maxFiles: '4' })
// @ts-expect-error no caller-supplied path option
effects.pickImage('selected', { path: '/private' })
// @ts-expect-error handles are strings
service.readPickedFile(42)

const host = createTestHost({ pkg: { name: 'type-test' } })
host.invoke('choose', { userGesture: true })
const publicService: DshGoService = host.dshGo
void publicService

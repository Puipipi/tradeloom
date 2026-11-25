// @dsh-go/plugin-kit — author kit for dsh-go native plugins. Zero runtime
// dependencies. Docs: docs/plugins/ in the dsh-go repository.
export {
  stack, row, text, metric, chart, compare, steps, callout, options, confirm,
  list, keyValue, progress, table, actions, image,
  textField, number, stepper, toggle, slider, select, segmented, chips, date, time, rating,
  form, tabs, collapsible, accordion, carousel, timeline, grid, badge, tag, avatar, codeBlock, divider, spacer, emptyState, gallery,
  bind, isBinding, action, walkView, COMPONENTS,
} from './view.js'
export { toolCard, toLosslessJson, jsonBytes, viewOfMeta, VIEW_KEY, CARD_MAX_BYTES } from './card.js'
export { hasComponent, hasSurface, protocolAtLeast, appAtLeast, localize, adaptView, DEFAULT_FALLBACKS, SURFACES } from './caps.js'
export * as effects from './effects.js'
export { checkEffects, checkPending } from './effect-check.js'

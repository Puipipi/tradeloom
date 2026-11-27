export const ROLE_DEFINITIONS = Object.freeze([
  Object.freeze({ id: 'center', preset: 'tradeloom-center', label: '中心', assistantLabel: '中心助手' }),
  Object.freeze({ id: 'product', preset: 'tradeloom-product', label: '商品专家', assistantLabel: '商品助手' }),
  Object.freeze({ id: 'market', preset: 'tradeloom-market-placeholder', label: '市场研究（占位）', assistantLabel: '市场助手' }),
  Object.freeze({ id: 'quote', preset: 'tradeloom-quote-placeholder', label: '询报价（占位）', assistantLabel: '询报价助手' }),
  Object.freeze({ id: 'delivery', preset: 'tradeloom-delivery', label: '交付协同', assistantLabel: '交付助手' }),
  Object.freeze({ id: 'order-production', preset: 'tradeloom-order-production', label: '订单与生产', assistantLabel: '订单跟进助手' }),
  Object.freeze({ id: 'user-profile', preset: 'tradeloom-user-profile-demo', label: '用户资料（演示）', assistantLabel: '资料助手' }),
])

export const ROLE_IDS = Object.freeze(ROLE_DEFINITIONS.map(role => role.id))
export const ROLE_PRESETS = Object.freeze(Object.fromEntries(ROLE_DEFINITIONS.map(role => [role.id, role.preset])))
export const ROLE_LABELS = Object.freeze(Object.fromEntries(ROLE_DEFINITIONS.map(role => [role.id, role.label])))
// Only these existing expert roles may execute a native workflow node.
export const WORKFLOW_AGENT_ROLE_IDS = Object.freeze(['product', 'delivery'])

export function publicRoleMetadata() {
  return ROLE_DEFINITIONS.map(({ id, label, assistantLabel }) => ({ id, label, assistantLabel }))
}

export const BUSINESS_MENUS = Object.freeze([
  { id: 'home', label: '总览', path: '/home' },
  { id: 'products', label: '商品', path: '/products' },
  { id: 'orders', label: '订单与生产', path: '/orders' },
  { id: 'customers', label: '客户', path: '/customers' },
  { id: 'agent-center', label: 'Agent 中心', path: '/agent-center' },
  { id: 'artifacts', label: '资料', path: '/artifacts' },
  { id: 'runs', label: '运行记录', path: '/runs' },
])

export const BUSINESS_ALIASES = Object.freeze({
  business: '/business/',
  'business-api': '/business-api/',
  'business-static': '/business-static/',
  'business-media': '/business-media/',
})

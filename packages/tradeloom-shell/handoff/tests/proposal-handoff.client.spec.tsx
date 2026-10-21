// @vitest-environment jsdom
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import React from 'C:/Users/23825/Desktop/ICT/workspace/runtime/tradeloom-harness/releases/0.2.1-rc.2-tradeloom-desktop-7/packages/client/ui-primitives/node_modules/react/index.js'
import { cleanup, fireEvent, render, screen } from 'C:/Users/23825/Desktop/ICT/workspace/runtime/tradeloom-harness/releases/0.2.1-rc.2-tradeloom-desktop-7/node_modules/@testing-library/react/dist/index.js'
import { afterEach, describe, expect, it, vi } from 'C:/Users/23825/Desktop/ICT/workspace/runtime/tradeloom-harness/releases/0.2.1-rc.2-tradeloom-desktop-7/node_modules/vitest/dist/index.js'
import { MarkdownDelegateProvider } from 'C:/Users/23825/Desktop/ICT/workspace/runtime/tradeloom-harness/releases/0.2.1-rc.2-tradeloom-desktop-7/packages/client/ui-primitives/src/index.ts'
import { MarkdownText } from 'C:/Users/23825/Desktop/ICT/workspace/runtime/tradeloom-harness/releases/0.2.1-rc.2-tradeloom-desktop-7/packages/client/ui-primitives/tests/markdown-test-components.tsx'

const clientSource = await readFile(resolve(process.env.TRADELOOM_HANDOFF_CLIENT_SOURCE || 'packages/tradeloom-shell/client.js'), 'utf8')
const TRUSTED_ORIGIN = 'http://192.168.1.23:3088'
const handoffHandlers = []

afterEach(() => {
  cleanup()
  for (const handler of handoffHandlers.splice(0)) document.removeEventListener('click', handler, true)
  vi.restoreAllMocks()
})

async function installClient() {
  const registrations = new Map()
  const layout = { selectPanel: vi.fn() }
  let plugin
  const require = specifier => {
    if (specifier === 'react') return React
    throw new Error(`Unexpected client dependency: ${specifier}`)
  }
  require.async = async specifier => {
    if (specifier === './client.scenes.js') {
      return {
        SceneTabs: () => null,
        register(_ctx, onBusinessOrigin) { onBusinessOrigin?.(TRUSTED_ORIGIN) },
        navigateBusiness(path) {
          if (path !== '/agent-center') return false
          layout.selectPanel('scene-workbench')
          return true
        },
      }
    }
    throw new Error(`Unexpected async client dependency: ${specifier}`)
  }
  const windowObject = {
    document,
    __ModuleLoader__: { load({ factory }) { plugin = factory(require) } },
  }
  runInNewContext(clientSource, { window: windowObject, URL, URLSearchParams, Promise })
  const addEventListener = vi.spyOn(document, 'addEventListener')
  await plugin.apply({
    layout,
    uiWorkspace: { openSession() {} },
    slots: {
      inject(_slot, register) { register() },
      register(descriptor, component) {
        if (descriptor.key) registrations.set(descriptor.key, component)
        return () => {}
      },
    },
  })
  const clickHandler = addEventListener.mock.calls.findLast(([type, , capture]) => type === 'click' && capture === true)?.[1]
  if (clickHandler) handoffHandlers.push(clickHandler)
  return { layout, AgentCenterPanel: registrations.get('business-agent-center') }
}

function renderLink(href, openExternalLink) {
  return render(React.createElement(MarkdownDelegateProvider, { openExternalLink },
    React.createElement(MarkdownText, { text: `[打开链接](${href})` })))
}

describe('native Markdown business proposal handoff', () => {
  it('routes a bare trusted Agent Center link into the existing blank Agent Center panel', async () => {
    const { layout, AgentCenterPanel } = await installClient()
    const openExternalLink = vi.fn()
    const windowOpen = vi.spyOn(window, 'open').mockReturnValue(null)

    render(React.createElement(React.Fragment, null,
      React.createElement(AgentCenterPanel),
      React.createElement(MarkdownDelegateProvider, { openExternalLink },
        React.createElement(MarkdownText, { text: `[打开工作台](${TRUSTED_ORIGIN}/business/agent-center)` }))))

    fireEvent.click(screen.getByRole('link', { name: '打开工作台' }))

    expect(openExternalLink).not.toHaveBeenCalled()
    expect(windowOpen).not.toHaveBeenCalled()
    expect(layout.selectPanel).toHaveBeenCalledWith('scene-workbench')
    expect(screen.getByTitle('织贸助手 · Agent 中心').getAttribute('src')).toBe('/business/agent-center')
  })

  it('intercepts only the trusted proposal click and routes it into the existing Agent Center panel', async () => {
    const { layout, AgentCenterPanel } = await installClient()
    const proposal = {
      version: 1,
      batch_id: 'demo-batch-01',
      user_goal: 'Prepare the reviewed sample catalog.',
      task_type: 'generate_deliverables',
    }
    const target = `${TRUSTED_ORIGIN}/business/agent-center#proposal=${encodeURIComponent(JSON.stringify(proposal))}`
    const windowOpen = vi.spyOn(window, 'open').mockReturnValue(null)
    const openExternalLink = vi.fn((url) => window.open(url, '_blank', 'noopener,noreferrer'))

    render(React.createElement(React.Fragment, null,
      React.createElement(AgentCenterPanel),
      React.createElement(MarkdownDelegateProvider, { openExternalLink },
        React.createElement(MarkdownText, { text: `[查看提案](${target})` }))))

    fireEvent.click(screen.getByRole('link', { name: '查看提案' }))

    expect(layout.selectPanel).toHaveBeenCalledWith('scene-workbench')
    expect(windowOpen).not.toHaveBeenCalled()
    expect(openExternalLink).not.toHaveBeenCalled()
    expect(layout.selectPanel).toHaveBeenCalledWith('scene-workbench')
    expect(screen.getByTitle('织贸助手 · Agent 中心').getAttribute('src')).toBe(
      `/business/agent-center#proposal=${encodeURIComponent(JSON.stringify(proposal))}`,
    )
  })

  it('leaves unrelated, malformed, or modified Markdown links on the existing external-link path', async () => {
    const { layout } = await installClient()
    const proposal = {
      version: 1, batch_id: 'demo-batch-01', user_goal: 'Review sample data.', task_type: 'prepare_product_data',
    }
    const validHash = `#proposal=${encodeURIComponent(JSON.stringify(proposal))}`
    const targets = [
      `http://192.168.1.24:3088/business/agent-center${validHash}`,
      `${TRUSTED_ORIGIN}/business/products${validHash}`,
      `${TRUSTED_ORIGIN}/business/agent-center?next=/home${validHash}`,
      `${TRUSTED_ORIGIN}/business/agent-center#proposal=${encodeURIComponent(JSON.stringify({ ...proposal, task_type: 'arbitrary' }))}`,
      `${TRUSTED_ORIGIN}/business/agent-center#proposal=${encodeURIComponent(JSON.stringify(proposal))}&proposal=${encodeURIComponent(JSON.stringify(proposal))}`,
    ]
    const openExternalLink = vi.fn()
    const windowOpen = vi.spyOn(window, 'open').mockReturnValue(null)

    for (const target of targets) {
      renderLink(target, openExternalLink)
      fireEvent.click(screen.getByRole('link', { name: '打开链接' }))
      cleanup()
    }
    renderLink(`${TRUSTED_ORIGIN}/business/agent-center${validHash}`, openExternalLink)
    fireEvent.click(screen.getByRole('link', { name: '打开链接' }), { ctrlKey: true })

    expect(layout.selectPanel).not.toHaveBeenCalled()
    expect(openExternalLink).toHaveBeenCalledTimes(targets.length)
    expect(windowOpen).not.toHaveBeenCalled()
  })
})


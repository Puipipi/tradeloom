window.__ModuleLoader__.load({
  id: '@tradeloom/dsh-business-shell', chunk: 'client.mcp-runtime.js',
  factory() {
    function register() {
      // MCP configuration stays in the existing assistant/plugin settings.
      // Host manager/state/authorization remain intact; no duplicate composer
      // status page or controls are installed by the business shell.
    }
    return { register }
  },
})

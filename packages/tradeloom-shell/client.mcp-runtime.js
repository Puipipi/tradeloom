window.__ModuleLoader__.load({
  id: '@tradeloom/dsh-business-shell', chunk: 'client.mcp-runtime.js',
  factory() {
    function register() {
      // client.source-native.js loads and registers this chunk with its native
      // extensions. MCP configuration and controls live in native settings.
    }
    return { register }
  },
})

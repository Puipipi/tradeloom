// The existing full-context provider registers its actual scoped lifetime here.
// This registry carries no persona text, session data or recall authorization.
// A new mount is a new identity, even when it uses the same preset and scope.
export function createRecallContexts() {
  const mounts = new Set();
  let active = true;
  return Object.freeze({
    registerContext(ctx) {
      if (!active) return () => {};
      const mount = Object.freeze({ ctx });
      mounts.add(mount);
      return () => { mounts.delete(mount); };
    },
    current(chain, scopeOf, systemPrompt, raw) {
      if (!active) return undefined;
      for (const mount of mounts) {
        const { ctx } = mount;
        if (ctx.fiber?.state !== 2 || ctx.fiber.uid === null || ctx.fiber.uid === undefined) continue;
        const scope = scopeOf(ctx);
        if (scope !== undefined && scope !== null && chain.includes(scope)
          && raw(ctx.get('systemPrompt')) === systemPrompt) return mount;
      }
      return undefined;
    },
    dispose() { active = false; mounts.clear(); },
  });
}

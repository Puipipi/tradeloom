// Test-only tool: the real approval service gates one isolated marker write.
import { appendFile } from 'node:fs/promises';
import { defineTool } from '@deepseek-ai/dsh-tools';
export const name = 'web-approval-fixture';
export const inject = ['tools', 'approval'];
export function apply(ctx) {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'web_approval_marker', description: 'Synthetic test: request approval before writing the isolated marker.',
    parameters: { nonce: { type: 'string', required: true } },
    output: { schema: { type: 'object', properties: { text: { type: 'string', required: true } }, additionalProperties: false },
      render: (_args, result) => [{ type: 'text', text: result.text }] },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (args.nonce !== 'SYNTHETIC_FIXED_NONCE') throw Error('Unexpected fixture nonce');
      const outcome = await ctx.approval.request({ agent: exec.agent, callId: exec.callId,
        toolName: 'web_approval_marker', reason: 'Write one synthetic marker in the isolated test directory.', signal: exec.signal });
      if (outcome === 'allowed-once') {
        exec.signal.throwIfAborted();
        await appendFile(process.env.DSH_WEB_APPROVAL_MARKER, 'SYNTHETIC_MARKER\n');
      }
      return { text: 'SYNTHETIC_DECISION_' + outcome };
    },
  })));
}

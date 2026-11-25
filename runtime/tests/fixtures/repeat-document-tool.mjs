import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const { defineTool } = await import(pathToFileURL(join(process.env.DSH_PREFIX, 'node_modules/@deepseek-ai/dsh-tools/lib/index.js')));
export const inject = ['tools'];
export function apply(ctx) {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'own_document_echo',
    description: 'Read an owned JSON document and echo its own fields without side effects.',
    parameters: { document: { type: 'object', additionalProperties: true, required: true } },
    output: { schema: { type: 'object', properties: { text: { type: 'string', required: true } }, additionalProperties: false }, render: (_args, value) => [{ type: 'text', text: value.text }] },
    isConcurrencySafe: () => true,
    execute(args) { return { text: JSON.stringify({ keys: Object.keys(args.document), document: args.document }) }; },
  })));
}

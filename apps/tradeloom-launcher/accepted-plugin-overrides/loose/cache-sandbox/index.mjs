export default class CacheSandboxResultStorageAdapter {
	static inject = ["sandbox"];

	constructor(ctx) {
		const sandbox = ctx.sandbox;
		if ("prepareResultStorage" in sandbox) return;

		const prepareResultStorage = async function (argv, policy, signal) {
			signal?.throwIfAborted();
			if (process.platform !== "win32" || policy.mode !== "workspace-write" || !policy.sessionId) {
				throw new Error("unsupported cache authority");
			}
			if (this.runnerCommand || this.selectRunner(policy.mode).runner !== "windows-acl") {
				throw new Error("unsupported sandbox backend");
			}
			const result = await this.confine(argv, policy, signal);
			return { argv: result.argv, enforcement: result.enforcement };
		};

		Object.defineProperty(sandbox, "prepareResultStorage", {
			configurable: true,
			enumerable: false,
			value: prepareResultStorage,
			writable: true
		});
		const restore = () => {
			const current = Object.getOwnPropertyDescriptor(sandbox, "prepareResultStorage");
			if (current?.value !== prepareResultStorage) return;
			delete sandbox.prepareResultStorage;
		};
		try {
			ctx.effect(() => restore);
		} catch (error) {
			restore();
			throw error;
		}
	}
}



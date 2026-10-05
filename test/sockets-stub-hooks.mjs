export async function resolve(specifier, context, nextResolve) {
	if (specifier === 'cloudflare:sockets') {
		return { url: 'stub:cloudflare-sockets', shortCircuit: true };
	}
	return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
	if (url === 'stub:cloudflare-sockets') {
		return {
			format: 'module',
			source: 'export function connect() { throw new Error("connect() stub: 本测试不应走到真实 TCP"); }',
			shortCircuit: true
		};
	}
	return nextLoad(url, context);
}

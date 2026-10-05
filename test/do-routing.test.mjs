// Durable Object 化改造的回归挂具：node test/do-routing.test.mjs
// 在 Node 里直接跑 _worker.js，验证「只把 WS 隧道转发进 DO」这条新增入口的行为。
// 注意：这是单进程测试，Worker 与 DO 共用同一个模块实例（真机上两者是独立实例），
// 因此不要在这里依赖 运行于DurableObject 标志的隔离性。
import { register } from 'node:module';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

// ---- Workers 支持 crypto.subtle.digest('MD5')，Node 不支持，这里补齐 ----
const subtle = globalThis.crypto.subtle;
const origDigest = subtle.digest.bind(subtle);
Object.defineProperty(subtle, 'digest', {
	configurable: true,
	value: async (alg, data) => {
		if (String(alg).toUpperCase() === 'MD5') {
			const b = createHash('md5').update(Buffer.from(data)).digest();
			return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
		}
		return origDigest(alg, data);
	}
});

// ---- 用 stub 顶掉 cloudflare:sockets，再加载被测文件 ----
register(new URL('./sockets-stub-hooks.mjs', import.meta.url).href);
const mod = await import(new URL('../_worker.js', import.meta.url).href);
const worker = mod.default;
const TunnelDO = mod.TunnelDO;

const CF = { colo: 'ZZZ', asn: 4837, country: 'US', city: 'Testville' };
let passed = 0;

function mkReq(url, headers = {}, cf = CF) {
	const r = new Request(url, { headers });
	if (cf) Object.defineProperty(r, 'cf', { value: cf, configurable: true });
	return r;
}

function mkEnv(extra = {}) {
	const seen = { idFromName: [], get: [], doFetch: [] };
	const ns = {
		idFromName(name) { seen.idFromName.push(name); return { name }; },
		get(id, opts) {
			seen.get.push({ name: id.name, opts });
			return {
				async fetch(req) {
					seen.doFetch.push(req);
					return { __fromDO: true, path: new URL(req.url).pathname, cfHeader: req.headers.get('X-CF-Properties') };
				}
			};
		}
	};
	return { env: { ADMIN: 'test-admin', TUNNEL_DO: ns, ...extra }, seen };
}

// ============ T1 基本转发 ============
{
	const { env, seen } = mkEnv();
	const res = await worker.fetch(mkReq('https://vless.example.com/ws', { Upgrade: 'websocket' }), env, {});
	assert.equal(res.__fromDO, true, 'T1: WS 请求应被转发进 DO');
	assert.deepEqual(seen.idFromName, ['tunnel-0'], 'T1: 默认 DO_SHARDS=1 → id 为 tunnel-0');
	assert.equal(seen.get[0].opts.locationHint, 'wnam', 'T1: 默认 locationHint 应为 wnam');
	assert.equal(seen.doFetch[0].headers.get('X-CF-Properties'), JSON.stringify(CF), 'T1: cf 必须注入 X-CF-Properties');
	console.log('✅ T1 WS 升级 → DO，分片/locationHint/cf 头均正确');
	passed++;
}

// ============ T2 Upgrade 头大小写 ============
{
	const { env, seen } = mkEnv();
	await worker.fetch(mkReq('https://vless.example.com/ws', { Upgrade: 'WebSocket' }), env, {});
	assert.equal(seen.doFetch.length, 1, 'T2: Upgrade: WebSocket（混合大小写）也必须转发');
	console.log('✅ T2 Upgrade 头大小写不敏感');
	passed++;
}

// ============ T3 分片与区域可配 ============
{
	const names = new Set(), hints = new Set();
	for (let i = 0; i < 300; i++) {
		const { env, seen } = mkEnv({ DO_SHARDS: '3', DO_REGION: 'apac' });
		await worker.fetch(mkReq('https://vless.example.com/ws', { Upgrade: 'websocket' }), env, {});
		names.add(seen.idFromName[0]);
		hints.add(seen.get[0].opts.locationHint);
	}
	assert.deepEqual([...names].sort(), ['tunnel-0', 'tunnel-1', 'tunnel-2'], 'T3: DO_SHARDS=3 应只在 3 个分片间分布');
	assert.deepEqual([...hints], ['apac'], 'T3: DO_REGION 应透传为 locationHint');
	console.log('✅ T3 DO_SHARDS=3 → 3 个分片；DO_REGION=apac → locationHint');
	passed++;
}

// ============ T4 无 ADMIN 不转发（与上游入口判定一致） ============
{
	const { env, seen } = mkEnv({ ADMIN: undefined });
	globalThis.fetch = async () => new Response('<html>ok</html>', { headers: { 'content-type': 'text/html' } });
	await worker.fetch(mkReq('https://vless.example.com/ws', { Upgrade: 'websocket' }), env, {});
	assert.equal(seen.doFetch.length, 0, 'T4: 没有管理员密码时不应占用 DO');
	console.log('✅ T4 未配置 ADMIN → 不转发进 DO');
	passed++;
}

// ============ T5 非 WS 请求留在 Worker ============
{
	const { env, seen } = mkEnv({ UUID: '90cd4a77-141a-43c9-991b-08263cfe9c10', URL: 'https://example.com' });
	let originHits = 0;
	globalThis.fetch = async () => { originHits++; return new Response('<html>origin</html>', { headers: { 'content-type': 'text/html' } }); };
	const res = await worker.fetch(mkReq('https://vless.example.com/'), env, {});
	assert.equal(seen.doFetch.length, 0, 'T5: 普通 HTTP 请求不应进 DO');
	assert.equal(res.status, 200, 'T5: 普通请求仍由 Worker 正常处理');
	assert.ok(originHits >= 1, 'T5: 伪装页反代应正常发起');
	console.log('✅ T5 非 WS 请求留在 Worker（KV/面板/订阅路径不受影响）');
	passed++;
}

// ============ T6 DO 侧 cf 还原（端到端） ============
{
	let capturedCf = null;
	globalThis.fetch = async (u, init) => { capturedCf = init?.cf; return new Response('<html>origin</html>', { headers: { 'content-type': 'text/html' } }); };
	const state = { waitUntil() { } };
	const doEnv = { ADMIN: 'test-admin', UUID: '90cd4a77-141a-43c9-991b-08263cfe9c10', URL: 'https://example.com' };
	const doInstance = new TunnelDO(state, doEnv);

	const req = new Request('https://vless.example.com/', { headers: { 'X-CF-Properties': JSON.stringify(CF) } });
	const res = await doInstance.fetch(req);
	assert.deepEqual(capturedCf, CF, 'T6: DO 内的 request.cf 必须由 X-CF-Properties 完整还原');
	assert.equal(res.status, 200, 'T6: DO 内业务逻辑应正常执行');

	// 反向对照：没有该头时应退化为 {}，而不是抛错
	capturedCf = null;
	await doInstance.fetch(new Request('https://vless.example.com/'));
	assert.deepEqual(capturedCf, {}, 'T6: 缺少 X-CF-Properties 时应退化为 {}');
	console.log('✅ T6 DO 内 request.cf 由 X-CF-Properties 正确还原');
	passed++;
}

console.log(`\n全部通过：${passed}/6`);

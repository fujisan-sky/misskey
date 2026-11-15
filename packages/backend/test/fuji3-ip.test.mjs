/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { loadFuji3Module } from './fuji3-api-loader.mjs';

const { createFuji3IpGuard } = await loadFuji3Module('fuji3-ip');
const { registerFuji3ChatApi } = await loadFuji3Module('fuji3chat');
const { registerFuji3QaApi } = await loadFuji3Module('fuji3qa');

function env(t, name, value) {
	const old = process.env[name];
	if (value === undefined) delete process.env[name]; else process.env[name] = value;
	t.after(() => { if (old === undefined) delete process.env[name]; else process.env[name] = old; });
}

test('address matching, CIDR boundaries, strict configuration and startup snapshot', async t => {
	const cases = [
		[undefined, '203.0.113.1', 200], ['', '203.0.113.1', 200], ['  ', '::1', 200],
		['192.168.0.183', '192.168.0.183', 200], ['192.168.0.183', '192.168.0.184', 403],
		['192.168.0.183', '::ffff:192.168.0.183', 200],
		['::ffff:192.168.0.183', '192.168.0.183', 200],
		['::ffff:192.168.0.183/120', '192.168.0.255', 200],
		['::ffff:192.168.0.183/95', '::ffff:192.168.0.183', 200],
		['192.168.0.183/32', '192.168.0.184', 403],
		['192.168.0.183/24', '192.168.0.255', 200], ['192.168.0.183/24', '192.168.1.0', 403],
		['0.0.0.0/0', '203.0.113.1', 200],
		['2403:7800:6539:a0::/64', '2403:7800:6539:a0:ffff:ffff:ffff:ffff', 200],
		['2403:7800:6539:a0::/64', '2403:7800:6539:a1::', 403],
		['2001:db8::1/128', '2001:0db8:0:0:0:0:0:1', 200], ['2001:db8::1', '2001:db8::2', 403],
		['::/0', '2001:db8::1', 200], ['::/0', '192.168.0.183', 403],
		[' 192.168.0.183 , 2001:db8::1 ', '2001:db8::1', 200],
		...['bad', '2403:7800:6539:a0/64', '192.168.0.1/33', '::1/129', '::1/-1', '::1/',
			'::1/64/1', '127.1', '192.168.0.183,', ','].map(value => [value, '192.168.0.183', 503]),
	];
	for (const [value, remoteAddress, status] of cases) {
		await t.test(`${value}: ${remoteAddress}`, async st => {
			env(st, 'FUJI3CHAT_IP', value);
			const app = Fastify();
			st.after(() => app.close());
			app.post('/test', { onRequest: createFuji3IpGuard(app, 'FUJI3CHAT_IP') }, async () => ({ ok: true }));
			process.env.FUJI3CHAT_IP = '203.0.113.255';
			const response = await app.inject({ method: 'POST', url: '/test', remoteAddress });
			assert.equal(response.statusCode, status, response.body);
			if (status !== 200) assert.equal(response.headers['cache-control'], 'no-store');
		});
	}
});

test('all protected routes reject before side effects; other routes and separate allowlists remain available', async t => {
	env(t, 'FUJI3CHAT_IP', '192.168.0.183');
	env(t, 'FUJI3QA_IP', '192.168.0.184');
	for (const name of ['FUJI3CHAT', 'FUJI3QA']) {
		env(t, `${name}_URL`, 'https://example.test');
		env(t, `${name}_SSO_SECRET`, 's'.repeat(40));
	}
	let calls = 0;
	const fail = async () => { calls++; throw new Error('Unexpected side effect'); };
	const deps = { config: { url: 'https://misskey.test' }, redis: { get: fail, set: fail, eval: fail, incr: fail, expire: fail },
		usersRepository: { findOneBy: fail }, authenticateService: { authenticate: fail }, userEntityService: { pack: fail }, postNote: fail };
	const app = Fastify();
	t.after(() => app.close());
	registerFuji3ChatApi(app, deps);
	registerFuji3QaApi(app, deps);
	for (const [url, allowed] of [['/fuji3chat/exchange', '192.168.0.183'], ['/fuji3qa/exchange', '192.168.0.184'], ['/fuji3qa/post-note', '192.168.0.184']]) {
		const payload = url.endsWith('post-note')
			? { grant: 'g'.repeat(43), audience: 'https://example.test', requestId: 'a'.repeat(36), text: 'test', visibility: 'public' }
			: { code: 'c'.repeat(43), state: 's'.repeat(43), codeVerifier: 'v'.repeat(43) };
		const denied = await app.inject({ method: 'POST', url, payload, remoteAddress: allowed.endsWith('183') ? '192.168.0.184' : '192.168.0.183', headers: { authorization: 'Bearer ' + 's'.repeat(40), 'x-forwarded-for': allowed } });
		assert.equal(denied.statusCode, 403);
		assert.equal(denied.json().error, 'IP_NOT_ALLOWED');
		assert.equal(calls, 0);
		const authorizedIp = await app.inject({ method: 'POST', url, payload, remoteAddress: allowed });
		assert.equal(authorizedIp.statusCode, 401); // IP permission never replaces client authentication.
	}
	for (const name of ['fuji3chat', 'fuji3qa']) {
		assert.equal((await app.inject({ url: `/${name}/config` })).statusCode, 200);
		assert.equal((await app.inject({ method: 'POST', url: `/${name}/issue`, payload: { i: 'native', state: 's'.repeat(43), codeChallenge: 'c'.repeat(43) } })).json().error, 'INVALID_ORIGIN');
	}
	assert.equal(calls, 0);
});

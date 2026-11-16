/*
 * SPDX-FileCopyrightText: mikop and fujisky-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Standalone route contract tests; no running Misskey, database, or external requests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import Fastify from 'fastify';

const source = await readFile(new URL('../src/server/api/fuji3qa.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { registerFuji3QaApi } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
const secret = 'test-secret-' + 's'.repeat(40);
const verifier = 'v'.repeat(43), state = 's'.repeat(43);
const digest = value => createHash('sha256').update(value).digest('base64url');

async function setup(t, issuer = 'https://gp.miku2go.com', destination = issuer === 'https://gp.miku2go.com' ? 'https://chat.misskey.pink' : 'https://fuji3.top', key = secret) {
	const previousUrl = process.env.FUJI3QA_URL, previousSecret = process.env.FUJI3QA_SSO_SECRET;
	process.env.FUJI3QA_URL = destination;
	t.after(() => {
		if (previousUrl === undefined) delete process.env.FUJI3QA_URL; else process.env.FUJI3QA_URL = previousUrl;
		if (previousSecret === undefined) delete process.env.FUJI3QA_SSO_SECRET; else process.env.FUJI3QA_SSO_SECRET = previousSecret;
	});
	process.env.FUJI3QA_SSO_SECRET = key;
	const values = new Map();
	const control = { user: { id: 'alice', username: 'alice', host: null, token: 'native', isSuspended: false, isDeleted: false }, access: null, now: 0, packs: 0 };
	const app = Fastify();
	const deps = {
		config: { url: issuer },
		redis: {
			incr: async key => { const value = (values.get(key) || 0) + 1; values.set(key, value); return value; },
			expire: async () => 1,
			set: async (key, value, ex, ttl, nx) => { assert.equal(ex, 'EX'); assert.ok([60, 72 * 60 * 60].includes(ttl)); assert.equal(nx, 'NX'); values.set(key, { value, expires: control.now + ttl }); return 'OK'; },
			eval: async (_script, _count, key, challenge, suppliedState) => {
				const entry = values.get(key);
				if (!entry || entry.expires <= control.now) return null;
				const data = JSON.parse(entry.value);
				if (data.challenge !== challenge || data.state !== suppliedState) return null;
				values.delete(key); return entry.value;
			},
		},
		authenticateService: { authenticate: async token => token === 'native' ? [control.user, control.access] : [null, null] },
		usersRepository: { findOneBy: async () => control.user },
		userEntityService: { pack: async (_user, _me, options) => { assert.equal(options.includeSecrets, false); control.packs++; return { ...control.user, token: 'MUST_NOT_LEAK', email: 'private@test', description: '**profile**', createdAt: '2020-01-01', followingCount: 4, followersCount: 5, notesCount: 6 }; } },
	};
	registerFuji3QaApi(app, deps);
	t.after(() => app.close());
	const issue = (body = {}, origin = issuer) => app.inject({ method: 'POST', url: '/fuji3qa/issue', headers: { origin }, payload: { i: 'native', state, codeChallenge: digest(verifier), ...body } });
	const exchange = (code, body = {}, authorization = 'Bearer ' + secret) => app.inject({ method: 'POST', url: '/fuji3qa/exchange', headers: { authorization }, payload: { code, state, codeVerifier: verifier, ...body } });
	return { app, control, issue, exchange, deps };
}

test('native login exchanges once and returns profile plus QA grant without native token', async t => {
	const { issue, exchange } = await setup(t);
	const issued = await issue(); assert.equal(issued.statusCode, 200);
	const { code } = issued.json(); assert.match(code, /^[A-Za-z0-9_-]{43}$/);
	const result = await exchange(code); assert.equal(result.statusCode, 200);
	assert.equal(result.json().audience, 'https://chat.misskey.pink');
	assert.equal(result.json().noteGrant.scope, 'qa:post-note');
	assert.equal(result.json().user.description, '**profile**');
	assert.equal('token' in result.json().user, false); assert.equal('email' in result.json().user, false);
	assert.equal(result.headers['cache-control'], 'no-store');
	assert.equal((await exchange(code)).statusCode, 400);
});

test('wrong origin, unauthenticated user, and third-party token cannot issue', async t => {
	const { issue, control } = await setup(t);
	assert.equal((await issue({}, 'https://evil.test')).statusCode, 403);
	assert.equal((await issue({ i: 'wrong' })).statusCode, 403);
	control.access = { permission: ['read:account'] };
	assert.equal((await issue()).statusCode, 403);
});

test('wrong client, verifier, or state cannot consume the valid code', async t => {
	const { issue, exchange } = await setup(t); const { code } = (await issue()).json();
	assert.equal((await exchange(code, {}, 'Bearer wrong')).statusCode, 401);
	assert.equal((await exchange(code, { codeVerifier: 'x'.repeat(43) })).statusCode, 400);
	assert.equal((await exchange(code, { state: 'x'.repeat(43) })).statusCode, 400);
	assert.equal((await exchange(code)).statusCode, 200);
});

test('expiration and concurrent replay fail', async t => {
	const { issue, exchange, control } = await setup(t);
	const first = (await issue()).json().code; control.now = 60;
	assert.equal((await exchange(first)).statusCode, 400);
	const second = (await issue()).json().code;
	assert.deepEqual((await Promise.all([exchange(second), exchange(second)])).map(r => r.statusCode).sort(), [200, 400]);
});

test('suspension, deletion, remote user and revoked native token are rejected', async t => {
	const { issue, exchange, control } = await setup(t);
	for (const field of ['isSuspended', 'isDeleted']) {
		const { code } = (await issue()).json(); control.user[field] = true;
		assert.equal((await exchange(code)).statusCode, 403); assert.equal((await issue()).statusCode, 403);
		control.user[field] = false;
	}
	control.user.host = 'remote.test'; assert.equal((await issue()).statusCode, 403);
	control.user.host = null; control.user.token = 'revoked'; assert.equal((await issue()).statusCode, 403);
});

test('invalid parameters and excessive issuance are rejected', async t => {
	const { issue } = await setup(t);
	assert.equal((await issue({ state: 'bad' })).statusCode, 400);
	for (let i = 0; i < 10; i++) assert.equal((await issue()).statusCode, 200);
	assert.equal((await issue()).statusCode, 429);
});

test('destination comes from environment for production and arbitrary issuers', async t => {
	const production = await setup(t, 'https://misskey.day');
	const { code } = (await production.issue()).json();
	assert.equal((await production.exchange(code)).json().audience, 'https://fuji3.top');
	const unknown = await setup(t, 'https://other.test');
	const otherCode = (await unknown.issue()).json().code;
	assert.equal((await unknown.exchange(otherCode)).json().issuer, 'https://other.test');
	assert.equal((await unknown.exchange(otherCode)).statusCode, 400);
});

test('public configuration exposes only normalized URL and never credentials', async t => {
	const { app } = await setup(t, 'https://gp.miku2go.com', 'https://chat.misskey.pink/');
	const response = await app.inject({ method: 'GET', url: '/fuji3qa/config' });
	assert.deepEqual(response.json(), { url: 'https://chat.misskey.pink' });
	assert.equal(response.headers['cache-control'], 'no-store');
	assert.equal(response.body.includes(secret), false);
});

test('invalid or missing URL and secret disable configuration and both APIs', async t => {
	for (const destination of ['', 'http://chat.test', 'https://user:pass@chat.test', 'https://chat.test/path', 'https://chat.test?next=bad', 'https://chat.test#bad', 'bad']) {
		const { app, issue, exchange } = await setup(t, 'https://gp.miku2go.com', destination);
		assert.deepEqual((await app.inject({ method: 'GET', url: '/fuji3qa/config' })).json(), { url: null });
		assert.equal((await issue()).statusCode, 503);
		assert.equal((await exchange('c'.repeat(43))).statusCode, 503);
	}
	for (const key of ['', 'short', 'x'.repeat(32) + '\n']) {
		const { app, issue } = await setup(t, 'https://gp.miku2go.com', 'https://chat.misskey.pink', key);
		assert.deepEqual((await app.inject({ method: 'GET', url: '/fuji3qa/config' })).json(), { url: null });
		assert.equal((await issue()).statusCode, 503);
	}
});

test('Chat and QA coexist and cannot exchange each others codes, even with the same test key', async t => {
    const oldUrl = process.env.FUJI3CHAT_URL, oldSecret = process.env.FUJI3CHAT_SSO_SECRET;
    process.env.FUJI3CHAT_URL = 'https://chat.example.test';
    process.env.FUJI3CHAT_SSO_SECRET = secret;
    t.after(() => {
        if (oldUrl === undefined) delete process.env.FUJI3CHAT_URL; else process.env.FUJI3CHAT_URL = oldUrl;
        if (oldSecret === undefined) delete process.env.FUJI3CHAT_SSO_SECRET; else process.env.FUJI3CHAT_SSO_SECRET = oldSecret;
    });
    const original = await readFile(new URL('../src/server/api/fuji3chat.ts', import.meta.url), 'utf8');
    const js = ts.transpileModule(original, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
    const { registerFuji3ChatApi } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
    const { app, issue, exchange, deps } = await setup(t, 'https://misskey.day', 'https://qa.example.test');
    registerFuji3ChatApi(app, deps);
    const qaCode = (await issue()).json().code;
    const exchangeChat = code => app.inject({ method: 'POST', url: '/fuji3chat/exchange', headers: { authorization: 'Bearer ' + secret }, payload: { code, state, codeVerifier: verifier } });
    assert.equal((await exchangeChat(qaCode)).statusCode, 400);
    assert.equal((await exchange(qaCode)).statusCode, 200);
    const chatCode = (await app.inject({ method: 'POST', url: '/fuji3chat/issue', headers: { origin: 'https://misskey.day' }, payload: { i: 'native', state, codeChallenge: digest(verifier) } })).json().code;
    assert.equal((await exchange(chatCode)).statusCode, 400);
    assert.equal((await exchangeChat(chatCode)).statusCode, 200);
});

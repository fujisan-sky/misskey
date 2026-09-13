/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Standalone route contract tests; no running Misskey, database, or external requests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import Fastify from 'fastify';

const source = await readFile(new URL('../src/server/api/fuji3chat.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { registerFuji3ChatApi } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
const secret = 'test-secret-' + 's'.repeat(40);
const verifier = 'v'.repeat(43), state = 's'.repeat(43);
const digest = value => createHash('sha256').update(value).digest('base64url');

async function setup(t, issuer = 'https://gp.miku2go.com') {
	process.env.FUJI3CHAT_SSO_SECRET = secret;
	const values = new Map();
	const control = { user: { id: 'alice', username: 'alice', host: null, token: 'native', isSuspended: false, isDeleted: false }, access: null, now: 0, packs: 0 };
	const app = Fastify();
	registerFuji3ChatApi(app, {
		config: { url: issuer },
		redis: {
			incr: async key => { const value = (values.get(key) || 0) + 1; values.set(key, value); return value; },
			expire: async () => 1,
			set: async (key, value, ex, ttl, nx) => { assert.equal(ex, 'EX'); assert.equal(ttl, 60); assert.equal(nx, 'NX'); values.set(key, { value, expires: control.now + ttl }); return 'OK'; },
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
	});
	t.after(() => app.close());
	const issue = (body = {}, origin = issuer) => app.inject({ method: 'POST', url: '/fuji3chat/issue', headers: { origin }, payload: { i: 'native', state, codeChallenge: digest(verifier), ...body } });
	const exchange = (code, body = {}, authorization = 'Bearer ' + secret) => app.inject({ method: 'POST', url: '/fuji3chat/exchange', headers: { authorization }, payload: { code, state, codeVerifier: verifier, ...body } });
	return { app, control, issue, exchange };
}

test('native login issues a code, exchanges once, and returns only profile fields', async t => {
	const { issue, exchange } = await setup(t);
	const issued = await issue(); assert.equal(issued.statusCode, 200);
	const { code } = issued.json(); assert.match(code, /^[A-Za-z0-9_-]{43}$/);
	const result = await exchange(code); assert.equal(result.statusCode, 200);
	assert.equal(result.json().audience, 'https://chat.misskey.pink');
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

test('production destination is fixed and unsupported host stays disabled', async t => {
	const production = await setup(t, 'https://misskey.day');
	const { code } = (await production.issue()).json();
	assert.equal((await production.exchange(code)).json().audience, 'https://fuji3.top');
	const unknown = await setup(t, 'https://other.test');
	assert.equal((await unknown.issue()).statusCode, 503);
});

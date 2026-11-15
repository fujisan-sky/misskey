/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import Fastify from 'fastify';

const source = await readFile(new URL('../src/server/api/fuji3qa.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { registerFuji3QaApi } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
const secret = 'test-only-' + 's'.repeat(40);
const issuer = 'https://misskey.day', audience = 'https://qa.example.test';
const digest = value => createHash('sha256').update(value).digest('base64url');
const verifier = 'v'.repeat(43), state = 's'.repeat(43);

async function setup(t) {
  const oldUrl = process.env.FUJI3QA_URL, oldKey = process.env.FUJI3QA_SSO_SECRET;
  process.env.FUJI3QA_URL = audience; process.env.FUJI3QA_SSO_SECRET = secret;
  t.after(() => {
    if (oldUrl === undefined) delete process.env.FUJI3QA_URL; else process.env.FUJI3QA_URL = oldUrl;
    if (oldKey === undefined) delete process.env.FUJI3QA_SSO_SECRET; else process.env.FUJI3QA_SSO_SECRET = oldKey;
  });
  const values = new Map();
  const control = { now: 0, calls: 0, user: { id: 'alice', username: 'alice', host: null, token: 'native', isSuspended: false, isDeleted: false }, failure: null };
  const redis = {
    set: async(key, value, _ex, ttl, nx) => {const entry = values.get(key); if (nx === 'NX' && entry && entry.expires > control.now) return null; values.set(key, { value, expires: control.now + ttl }); return 'OK';},
    get: async key => {const entry = values.get(key); return entry && entry.expires > control.now ? entry.value : null;},
    del: async key => values.delete(key) ? 1 : 0,
    incr: async key => {const val = Number(await redis.get(key) || 0) + 1; values.set(key, { value: String(val), expires: control.now + 120 }); return val;},
    expire: async() => 1,
    eval: async(_script, _count, key, challenge, suppliedState) => {const value = await redis.get(key); if (!value) return null; const data = JSON.parse(value); if (data.challenge !== challenge || data.state !== suppliedState) return null; await redis.del(key); return value;},
  };
  const app = Fastify();
  registerFuji3QaApi(app, {
    config: { url: issuer }, redis,
    authenticateService: { authenticate: async token => token === 'native' ? [control.user, null] : [null, null] },
    usersRepository: { findOneBy: async ({ id }) => id === control.user.id ? control.user : null },
    userEntityService: { pack: async user => user },
    postNote: async(user, text, visibility) => {control.calls++; assert.equal(user.id, 'alice'); if (control.failure) throw control.failure; return { createdNote: { id: 'note123', visibility, text } };},
  });
  t.after(() => app.close());

  async function grant() {
    const issued = await app.inject({ method: 'POST', url: '/fuji3qa/issue', headers: { origin: issuer }, payload: { i: 'native', state, codeChallenge: digest(verifier) } });
    assert.equal(issued.statusCode, 200, issued.body);
    const result = await app.inject({ method: 'POST', url: '/fuji3qa/exchange', headers: { authorization: 'Bearer ' + secret }, payload: { code: issued.json().code, state, codeVerifier: verifier } });
    assert.equal(result.statusCode, 200, result.body);
    assert(!result.body.includes('native'));
    return result.json().noteGrant;
  }

  const post = (token, extra = {}, authorization = 'Bearer ' + secret) => app.inject({ method: 'POST', url: '/fuji3qa/post-note', headers: { authorization }, payload: { grant: token, audience, requestId: '12345678-1234-1234-1234-123456789abc', text: 'Q. 質問\nA. 回答', visibility: 'home', ...extra } });
  return { app, control, grant, post, redis, values };
}

test('native SSO automatically grants 72-hour QA-only posting; shared key alone cannot impersonate', async t => {
  const { grant, post, control } = await setup(t);
  const permit = await grant(); assert.equal(permit.scope, 'qa:post-note'); assert.equal(permit.userId, 'alice');
  assert(permit.expiresAt > Date.now() / 1000 && permit.expiresAt <= Date.now() / 1000 + 72 * 60 * 60);
  assert.equal((await post('x'.repeat(43))).statusCode, 403);
  assert.equal((await post(permit.token, { userId: 'other' })).statusCode, 400);
  assert.equal((await post(permit.token, { audience: 'https://chat.example.test' })).statusCode, 403);
  assert.equal((await post(permit.token, {}, 'Bearer bad')).statusCode, 401);
  assert.equal(control.calls, 0);
  assert.equal((await post(permit.token)).statusCode, 200); assert.equal(control.calls, 1);
});

test('three visibilities and size limit; duplicate replay returns original result without posting twice', async t => {
  const { grant, post, control } = await setup(t); const permit = await grant();
  assert.equal((await post(permit.token, { visibility: 'specified' })).statusCode, 400);
  assert.equal((await post(permit.token, { text: 'a'.repeat(3001) })).statusCode, 400);
  for (const [index, visibility] of ['public', 'followers', 'home'].entries()) {
    const requestId = `12345678-1234-1234-1234-123456789ab${index}`;
    const first = await post(permit.token, { visibility, requestId }); assert.equal(first.statusCode, 200);
    const again = await post(permit.token, { visibility, requestId }); assert.deepEqual(again.json(), first.json());
    assert.equal((await post(permit.token, { visibility, requestId, text: 'changed' })).statusCode, 409);
  }
  assert.equal(control.calls, 3);
});

test('72-hour expiry and account restrictions block posting; no revocation endpoints exist', async t => {
  const { grant, post, control, app } = await setup(t); const permit = await grant();
  control.user.isSuspended = true; assert.equal((await post(permit.token)).statusCode, 403); control.user.isSuspended = false;
  control.user.token = 'rotated'; assert.equal((await post(permit.token)).statusCode, 403); control.user.token = 'native';
  control.now = 72 * 60 * 60 - 1;
  assert.equal((await post(permit.token)).statusCode, 200);
  control.now = 72 * 60 * 60;
  assert.equal((await post(permit.token)).statusCode, 403);
  assert.equal(control.calls, 1);
  for (const url of ['/fuji3qa/revoke', '/fuji3qa/revoke-own']) {
    const response = await app.inject({ method: 'POST', url, payload: {} });
    assert.equal(response.statusCode, 404);
  }
});

test('normal posting restrictions are propagated and an uncertain failure never replays', async t => {
  const { grant, post, control } = await setup(t); const permit = await grant();
  control.failure = { code: 'ROLE_PERMISSION_DENIED', kind: 'permission' };
  assert.equal((await post(permit.token)).statusCode, 403);
  control.failure = new Error('unknown after side effect');
  const extra = { requestId: '12345678-1234-1234-1234-123456789abe' };
  assert.equal((await post(permit.token, extra)).statusCode, 500);
  assert.equal((await post(permit.token, extra)).statusCode, 500);
  assert.equal(control.calls, 2);
});

test('in-flight identical requests are serialized by Redis reservation', async t => {
  const { grant, post, control } = await setup(t); const permit = await grant();
  const responses = await Promise.all([post(permit.token), post(permit.token)]);
  assert.equal(control.calls, 1);
  assert(responses.some(response => response.statusCode === 200));
  assert(responses.every(response => [200, 409].includes(response.statusCode)));
});

test('QA entry delegates to the actual ordinary API pipeline including suspension, moved and rate checks', async() => {
  const errorSource = await readFile(new URL('../src/server/api/error.ts', import.meta.url), 'utf8');
  const compile = text => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, experimentalDecorators: true, emitDecoratorMetadata: false } }).outputText;
  const errorUrl = 'data:text/javascript;base64,' + Buffer.from(compile(errorSource)).toString('base64');
  const apiSource = (await readFile(new URL('../src/server/api/ApiCallService.ts', import.meta.url), 'utf8')).replace(/^import .*;\r?$/gm, '');
  const stubs = `import {ApiError} from '${errorUrl}'; const Injectable=()=>target=>target; const Inject=()=>()=>{}; const bindThis=(_target,_name,descriptor)=>descriptor; const DI={}; const getIpHash=()=>'';`;
  const { ApiCallService } = await import('data:text/javascript;base64,' + Buffer.from(stubs + compile(apiSource)).toString('base64'));
  const service = Object.create(ApiCallService.prototype);
  service.config = { enableIpRateLimit: false }; service.meta = { rootUserId: null };
  service.roleService = { getUserPolicies: async() => ({ rateLimitFactor: 1 }) };
  let limited = false, executions = 0;
  service.rateLimiterService = { limit: async() => limited ? { info: { resetMs: 1 } } : null };
  const ep = { name: 'notes/create', meta: { requireCredential: true, prohibitMoved: true, kind: 'write:notes', limit: { duration: 3600000, max: 300 } }, params: {}, exec: async data => {executions++; assert(data.noExtractMentions); return { createdNote: { id: 'test' } };} };
  const user = { id: 'alice', isSuspended: false, movedToUri: null }; const request = { method: 'POST', ip: '127.0.0.1', headers: {} };
  assert.deepEqual(await service.callQaNote(ep, user, 'Q and A', 'home', request), { createdNote: { id: 'test' } });
  user.isSuspended = true; await assert.rejects(service.callQaNote(ep, user, 'text', 'home', request), error => error.code === 'YOUR_ACCOUNT_SUSPENDED'); user.isSuspended = false;
  user.movedToUri = 'https://other.test/@alice'; await assert.rejects(service.callQaNote(ep, user, 'text', 'home', request), error => error.code === 'YOUR_ACCOUNT_MOVED'); user.movedToUri = null;
  limited = true; await assert.rejects(service.callQaNote(ep, user, 'text', 'home', request), error => error.code === 'RATE_LIMIT_EXCEEDED'); limited = false;
  await assert.rejects(service.callQaNote({ ...ep, name: 'admin/users/delete' }, user, 'text', 'home', request), error => error.code === 'ACCESS_DENIED');
  assert.equal(executions, 1);
});

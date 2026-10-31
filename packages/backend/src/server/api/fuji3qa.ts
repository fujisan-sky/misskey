/*
 * SPDX-FileCopyrightText: mikop and fujisky-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from '@/config.js';
import type { UsersRepository } from '@/models/_.js';
import type { UserEntityService } from '@/core/entities/UserEntityService.js';
import type { AuthenticateService } from './AuthenticateService.js';
import type { MiLocalUser } from '@/models/User.js';

function chatOrigin(value: string): string | null {
	try {
		const target = new URL(value);
		if (target.protocol !== 'https:' || target.username || target.password
			|| target.pathname !== '/' || target.search || target.hash) return null;
		return target.origin;
	} catch {
		return null;
	}
}

const randomPattern = '^[A-Za-z0-9_-]{43}$';
const digest = (value: string) => createHash('sha256').update(value).digest('base64url');
const prefix = 'fuji3qa:sso:';
// Check the browser binding and consume atomically, even across Misskey workers.
export const consumeCodeScript = `
local value = redis.call('GET', KEYS[1])
if not value then return nil end
local data = cjson.decode(value)
if data.challenge ~= ARGV[1] or data.state ~= ARGV[2] then return nil end
redis.call('DEL', KEYS[1])
return value
`;

type Dependencies = {
	config: Pick<Config, 'url'>;
	redis: Pick<Redis, 'set' | 'get' | 'incr' | 'expire' | 'eval'>;
	usersRepository: Pick<UsersRepository, 'findOneBy'>;
	authenticateService: Pick<AuthenticateService, 'authenticate'>;
	userEntityService: Pick<UserEntityService, 'pack'>;
	postNote: (user: MiLocalUser, text: string, visibility: string, request: FastifyRequest) => Promise<unknown>;
};

export function registerFuji3QaApi(fastify: FastifyInstance, deps: Dependencies) {
	const issuer = deps.config.url.replace(/\/$/, '');
	const audience = chatOrigin(process.env.FUJI3QA_URL ?? '');
	const secret = process.env.FUJI3QA_SSO_SECRET ?? '';
	const configured = Boolean(audience && /^[\x21-\x7e]{32,}$/.test(secret));
	const noCache = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
	const randomField = { type: 'string', pattern: randomPattern };
	const grantPrefix = 'fuji3qa:note-grant:';
	const grantLifetime = 72 * 60 * 60;
	const authorizedClient = (authorization: string | undefined) => {
		const supplied = authorization ?? '';
		const expected = `Bearer ${secret}`;
		return configured && Buffer.byteLength(supplied) === Buffer.byteLength(expected)
			&& timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
	};

	// Public settings contain the destination only, never the shared secret.
	fastify.get('/fuji3qa/config', async (_request, reply) => {
		reply.headers(noCache);
		return { url: configured ? audience : null };
	});

	fastify.post<{ Body: { i: string; state: string; codeChallenge: string } }>('/fuji3qa/issue', {
		bodyLimit: 4096,
		schema: { body: { type: 'object', additionalProperties: false, required: ['i', 'state', 'codeChallenge'], properties: {
			i: { type: 'string', minLength: 1, maxLength: 1024 }, state: randomField, codeChallenge: randomField,
		} } },
	}, async (request, reply) => {
		reply.headers(noCache);
		if (!configured) return reply.code(503).send({ error: 'SSO_NOT_CONFIGURED' });
		if (request.headers.origin !== issuer) return reply.code(403).send({ error: 'INVALID_ORIGIN' });
		let authenticated;
		try {
			authenticated = await deps.authenticateService.authenticate(request.body.i);
		} catch {
			return reply.code(401).send({ error: 'AUTHENTICATION_REQUIRED' });
		}
		const [identity, accessToken] = authenticated;
		// Only the native logged-in client may silently authorize this first-party integration.
		if (!identity || accessToken) return reply.code(403).send({ error: 'NATIVE_LOGIN_REQUIRED' });
		const user = await deps.usersRepository.findOneBy({ id: identity.id });
		if (!user || user.host !== null || user.isSuspended || user.isDeleted || user.token !== request.body.i) {
			return reply.code(403).send({ error: 'USER_UNAVAILABLE' });
		}
		const rateKey = `${prefix}rate:${user.id}:${Math.floor(Date.now() / 60000)}`;
		const count = await deps.redis.incr(rateKey);
		if (count === 1) await deps.redis.expire(rateKey, 120);
		if (count > 10) return reply.header('Retry-After', '60').code(429).send({ error: 'TRY_AGAIN_LATER' });
		const code = randomBytes(32).toString('base64url');
		const stored = await deps.redis.set(prefix + digest(code), JSON.stringify({
			userId: user.id, challenge: request.body.codeChallenge, state: request.body.state,
			nativeHash: digest(user.token!),
		}), 'EX', 60, 'NX');
		if (stored !== 'OK') return reply.code(503).send({ error: 'TRY_AGAIN_LATER' });
		return { code };
	});

	fastify.post<{ Body: { code: string; state: string; codeVerifier: string } }>('/fuji3qa/exchange', {
		bodyLimit: 4096,
		schema: { body: { type: 'object', additionalProperties: false, required: ['code', 'state', 'codeVerifier'], properties: {
			code: randomField, state: randomField, codeVerifier: randomField,
		} } },
	}, async (request, reply) => {
		reply.headers(noCache);
		if (!configured) return reply.code(503).send({ error: 'SSO_NOT_CONFIGURED' });
		const supplied = request.headers.authorization ?? '';
		const expected = `Bearer ${secret}`;
		if (Buffer.byteLength(supplied) !== Buffer.byteLength(expected)
			|| !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
			return reply.code(401).send({ error: 'INVALID_CLIENT' });
		}
		const value = await deps.redis.eval(consumeCodeScript, 1, prefix + digest(request.body.code),
			digest(request.body.codeVerifier), request.body.state);
		if (typeof value !== 'string') return reply.code(400).send({ error: 'INVALID_CODE' });
		const { userId, nativeHash } = JSON.parse(value) as { userId: string; nativeHash?: string };
		const user = await deps.usersRepository.findOneBy({ id: userId });
		if (!user || user.host !== null || user.isSuspended || user.isDeleted
			|| !user.token || (nativeHash && digest(user.token) !== nativeHash)) {
			return reply.code(403).send({ error: 'USER_UNAVAILABLE' });
		}
		const packed = await deps.userEntityService.pack(user, user, { schema: 'MeDetailed', includeSecrets: false });
		// Successful native SSO always includes a QA-only posting grant (72 hours).
		const token = randomBytes(32).toString('base64url');
		const expiresAt = Math.floor(Date.now() / 1000) + grantLifetime;
		const stored = await deps.redis.set(grantPrefix + digest(token), JSON.stringify({
			userId, issuer, audience, scope: 'qa:post-note', nativeHash: digest(user.token), expiresAt,
		}), 'EX', grantLifetime, 'NX');
		if (stored !== 'OK') return reply.code(503).send({ error: 'TRY_AGAIN_LATER' });
		const noteGrant = { token, userId, issuer, audience, scope: 'qa:post-note', expiresAt };
		// Explicitly allowlist the profile fields required by Chat. Never return a native/API token.
		return { issuer, audience, noteGrant, user: {
			id: packed.id, username: packed.username, name: packed.name, host: null,
			avatarUrl: packed.avatarUrl, description: packed.description,
			createdAt: packed.createdAt, followingCount: packed.followingCount,
			followersCount: packed.followersCount, notesCount: packed.notesCount,
		} };
	});

	const capabilityProperties = { grant: randomField, audience: { type: 'string', maxLength: 2048 } };
	fastify.post<{ Body: { grant: string; audience: string; requestId: string; text: string; visibility: string } }>('/fuji3qa/post-note', {
		bodyLimit: 32768,
		preValidation: async (request, reply) => {
			if (!request.body || Object.keys(request.body).some(key => !['grant', 'audience', 'requestId', 'text', 'visibility'].includes(key))) {
				return reply.code(400).send({ error: 'INVALID_PARAMETERS' });
			}
			return undefined;
		},
		schema: { body: { type: 'object', additionalProperties: false,
			required: ['grant', 'audience', 'requestId', 'text', 'visibility'], properties: {
				...capabilityProperties, requestId: { type: 'string', pattern: '^[a-f0-9-]{36}$' },
				text: { type: 'string', minLength: 1, maxLength: 3000 },
				visibility: { type: 'string', enum: ['public', 'followers', 'home'] },
			} } },
	}, async (request, reply) => {
		reply.headers(noCache);
		if (!authorizedClient(request.headers.authorization)) return reply.code(401).send({ error: 'INVALID_CLIENT' });
		if (request.body.audience !== audience) return reply.code(403).send({ error: 'INVALID_AUDIENCE' });
		const raw = await deps.redis.get(grantPrefix + digest(request.body.grant));
		if (!raw) return reply.code(403).send({ error: 'GRANT_EXPIRED' });
		const grant = JSON.parse(raw) as { userId: string; issuer: string; audience: string; scope: string; expiresAt: number; nativeHash: string };
		if (grant.issuer !== issuer || grant.audience !== audience || grant.scope !== 'qa:post-note'
			|| grant.expiresAt <= Date.now() / 1000) return reply.code(403).send({ error: 'INVALID_GRANT' });
		const user = await deps.usersRepository.findOneBy({ id: grant.userId });
		if (!user || user.host !== null || user.isSuspended || user.isDeleted || !user.token
			|| digest(user.token) !== grant.nativeHash) {
			return reply.code(403).send({ error: 'USER_UNAVAILABLE' });
		}
		const resultKey = grantPrefix + 'result:' + digest(request.body.grant) + ':' + request.body.requestId;
		const fingerprint = digest(JSON.stringify([request.body.text, request.body.visibility]));
		// Reserve before posting. An interrupted request stays pending and is never replayed.
		const reserved = await deps.redis.set(resultKey, JSON.stringify({ fingerprint, status: 409, body: { error: 'POST_RESULT_UNKNOWN' } }), 'EX', 2592000, 'NX');
		if (reserved !== 'OK') {
			const saved = JSON.parse(await deps.redis.get(resultKey) ?? '{}') as { fingerprint?: string; status?: number; body?: unknown };
			if (saved.fingerprint !== fingerprint) return reply.code(409).send({ error: 'REQUEST_ID_REUSED' });
			return reply.code(saved.status ?? 409).send(saved.body ?? { error: 'POST_RESULT_UNKNOWN' });
		}
		try {
			// Full notes/create pipeline, including roles, moved status and rate limiting.
			const result = await deps.postNote(user as MiLocalUser, request.body.text, request.body.visibility, request);
			await deps.redis.set(resultKey, JSON.stringify({ fingerprint, status: 200, body: result }), 'EX', 2592000);
			return result;
		} catch (error) {
			const failure = error as { code?: string; kind?: string; httpStatusCode?: number };
			const status = failure.httpStatusCode ?? (failure.kind === 'permission' ? 403 : failure.kind === 'client' ? 400 : 500);
			const safeStatus = status >= 400 && status < 500 ? status : 500;
			const body = { error: safeStatus === 500 ? 'POST_RESULT_UNKNOWN' : failure.code ?? 'POST_REJECTED' };
			await deps.redis.set(resultKey, JSON.stringify({ fingerprint, status: safeStatus, body }), 'EX', 2592000);
			return reply.code(safeStatus).send(body);
		}
	});
}

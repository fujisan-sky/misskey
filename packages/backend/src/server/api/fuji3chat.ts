/*
 * SPDX-FileCopyrightText: mikop and fujisansky-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { FastifyInstance } from 'fastify';
import type { Config } from '@/config.js';
import type { UsersRepository } from '@/models/_.js';
import type { UserEntityService } from '@/core/entities/UserEntityService.js';
import type { AuthenticateService } from './AuthenticateService.js';

const destinations: Record<string, string> = {
	'https://gp.miku2go.com': 'https://chat.misskey.pink',
	'https://misskey.day': 'https://fuji3.top',
};
const randomPattern = '^[A-Za-z0-9_-]{43}$';
const digest = (value: string) => createHash('sha256').update(value).digest('base64url');
const prefix = 'fuji3chat:sso:';
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
	redis: Pick<Redis, 'set' | 'incr' | 'expire' | 'eval'>;
	usersRepository: Pick<UsersRepository, 'findOneBy'>;
	authenticateService: Pick<AuthenticateService, 'authenticate'>;
	userEntityService: Pick<UserEntityService, 'pack'>;
};

export function registerFuji3ChatApi(fastify: FastifyInstance, deps: Dependencies) {
	const issuer = deps.config.url.replace(/\/$/, '');
	const audience = destinations[issuer];
	const secret = process.env.FUJI3CHAT_SSO_SECRET ?? '';
	const configured = Boolean(audience && Buffer.byteLength(secret) >= 32);
	const noCache = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
	const randomField = { type: 'string', pattern: randomPattern };

	fastify.post<{ Body: { i: string; state: string; codeChallenge: string } }>('/fuji3chat/issue', {
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
		}), 'EX', 60, 'NX');
		if (stored !== 'OK') return reply.code(503).send({ error: 'TRY_AGAIN_LATER' });
		return { code };
	});

	fastify.post<{ Body: { code: string; state: string; codeVerifier: string } }>('/fuji3chat/exchange', {
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
		const { userId } = JSON.parse(value) as { userId: string };
		const user = await deps.usersRepository.findOneBy({ id: userId });
		if (!user || user.host !== null || user.isSuspended || user.isDeleted) {
			return reply.code(403).send({ error: 'USER_UNAVAILABLE' });
		}
		const packed = await deps.userEntityService.pack(user, user, { schema: 'MeDetailed', includeSecrets: false });
		// Explicitly allowlist the profile fields required by Chat. Never return a native/API token.
		return { issuer, audience, user: {
			id: packed.id, username: packed.username, name: packed.name, host: null,
			avatarUrl: packed.avatarUrl, description: packed.description,
			createdAt: packed.createdAt, followingCount: packed.followingCount,
			followersCount: packed.followersCount, notesCount: packed.notesCount,
		} };
	});
}

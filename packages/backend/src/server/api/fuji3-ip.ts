/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

// Compile once per API registration. Invalid configuration disables only the protected routes.
export function createFuji3IpGuard(fastify: FastifyInstance, variable: 'FUJI3CHAT_IP' | 'FUJI3QA_IP') {
	const value = process.env[variable]?.trim();
	let networks: ReturnType<typeof ipaddr.parseCIDR>[] = [];
	let invalid = false;
	if (value) {
		try {
			networks = value.split(',').map(entry => {
				const parts = entry.trim().split('/');
				const address = parts[0];
				const family = isIP(address);
				if (!family || parts.length > 2 || (parts.length === 2 && !/^\d+$/.test(parts[1]))) {
					throw new Error('Invalid IP or CIDR');
				}
				const bits = parts.length === 2 ? Number(parts[1]) : family === 4 ? 32 : 128;
				if (bits > (family === 4 ? 32 : 128)) throw new Error('Invalid prefix length');
				const network = ipaddr.parseCIDR(`${address}/${bits}`);
				// Match mapped IPv4 networks against the normalized IPv4 client address too.
				if (network[0].kind() === 'ipv6') {
					const ipv6 = network[0] as ipaddr.IPv6;
					if (ipv6.isIPv4MappedAddress() && bits >= 96) {
						return [ipv6.toIPv4Address(), bits - 96] as [ipaddr.IPv4, number];
					}
				}
				return network;
			});
		} catch {
			invalid = true;
			fastify.log.error(`${variable} contains an invalid IP allowlist; protected routes are unavailable`);
		}
	}

	return async (request: FastifyRequest, reply: FastifyReply) => {
		if (!value) return;
		reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
		if (invalid) return reply.code(503).send({ error: 'IP_RESTRICTION_NOT_CONFIGURED' });
		try {
			const address = ipaddr.process(request.ip);
			const original = ipaddr.parse(request.ip);
			if (networks.some(([network, bits]) => {
				const candidate = network.kind() === 'ipv6' ? original : address;
				return network.kind() === candidate.kind() && candidate.match(network, bits);
			})) return;
		} catch {
			// An unparseable client address must never bypass the allowlist.
		}
		return reply.code(403).send({ error: 'IP_NOT_ALLOWED' });
	};
}

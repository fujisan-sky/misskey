/*
 * SPDX-FileCopyrightText: misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { hostname } from '@@/js/config.js';
import { $i } from '@/i.js';
import { fuji3qaConfig } from '@/utility/fuji3qa-config.js';

/** Accept the legacy room ID or a canonical local user's relative QA path. */
export function isFuji3qaRoom(value: string, destination: string, localHostname: string): boolean {
	if (!value || /^[A-Za-z0-9]{10}$/.test(value)) return true;
	try {
		const target = new URL('/' + value, destination);
		const match = target.pathname.match(/^\/u\/([A-Za-z0-9_]+)@([^/]+)$/);
		return target.origin === destination && !target.username && !target.password
			&& !target.search && !target.hash && match !== null
			&& match[2] === localHostname && value === target.pathname.slice(1);
	} catch {
		return false;
	}
}

export function fuji3qaBadgeLink(user: { username: string; host?: string | null }, role: { id?: string }): string | null {
	const { url, roleId } = fuji3qaConfig;
	if (!$i || user.host != null || !url || !roleId || role.id !== roleId) return null;
	const room = 'u/' + encodeURIComponent(user.username) + '@' + hostname;
	if (!isFuji3qaRoom(room, url, hostname)) return null;
	return '/fuji3qa?' + new URLSearchParams({ room }).toString();
}

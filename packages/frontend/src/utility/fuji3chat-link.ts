/*
 * SPDX-FileCopyrightText: mikop and fujisky-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { fuji3chatConfig } from '@/utility/fuji3chat-config.js';

/** Only canonical room links to the configured Chat server enter SSO. */
export function fuji3chatRoomLink(value: string, local: string, loggedIn: boolean): string | null {
	if (!loggedIn || !fuji3chatConfig.url) return null;
	const destination = fuji3chatConfig.url;
	try {
		const target = new URL(value);
		const room = target.pathname.match(/^\/r\/([A-Za-z0-9]{10})\/?$/);
		if (target.origin !== destination || target.username || target.password
			|| target.search || target.hash || !room
			|| value !== destination + target.pathname) return null;
		const start = new URL('/api/auth/fuji3chat/start', destination);
		start.searchParams.set('host', new URL(local).hostname);
		start.searchParams.set('room', room[1]);
		return start.href;
	} catch {
		return null;
	}
}

/*
 * SPDX-FileCopyrightText: misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/** Keep the public URL for previews; use the viewer's Misskey host for SSO. */
export function fuji3qaRoomLink(value: string, destination: string | null, local: string, loggedIn: boolean): string | null {
	if (!loggedIn || !destination) return null;
	try {
		const origin = new URL(destination);
		const target = new URL(value);
		if (origin.protocol !== 'https:' || origin.origin !== destination
			|| target.origin !== destination || target.username || target.password) return null;
		const code = target.pathname.match(/^\/r\/([A-Za-z0-9]{10})\/?$/);
		const account = target.pathname.match(/^\/u\/([A-Za-z0-9_]{1,128})(?:@([a-z0-9.-]+))?\/?$/);
		if (!code && !account) return null;
		const viewer = new URL(local);
		if (viewer.protocol !== 'https:' || viewer.username || viewer.password) return null;
		target.searchParams.set('sso_host', viewer.hostname);
		return target.href;
	} catch {
		return null;
	}
}

/*
 * SPDX-FileCopyrightText: mikop and fujisansky-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/** Only canonical room links on the paired deployment enter SSO. */
export function fuji3chatRoomLink(value: string, local: string, loggedIn: boolean): string | null {
	if (!loggedIn) return null;
	const destinations: Record<string, string> = {
		'https://gp.miku2go.com': 'https://chat.misskey.pink',
		'https://misskey.day': 'https://fuji3.top',
	};
	const destination = destinations[local];
	if (!destination) return null;
	const match = value.match(new RegExp('^' + destination.replaceAll('.', '\\.') + '/r/([A-Za-z0-9]{10})/?$'));
	if (!match) return null;
	return destination + '/api/auth/fuji3chat/start?room=' + match[1];
}

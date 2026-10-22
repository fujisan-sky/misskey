/*
 * SPDX-FileCopyrightText: mikop and fujisky-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export function getUserEmojiAccess(policies: {
	canManageCustomEmojis: boolean;
	canCreateEmoji: boolean;
	canManageUserEmoji: boolean;
}, isAdministrator: boolean) {
	const canManage = isAdministrator || policies.canManageCustomEmojis;
	return {
		canManage,
		canManageOwn: policies.canManageUserEmoji,
		userOnly: !canManage && !policies.canCreateEmoji && policies.canManageUserEmoji,
	};
}

export function canEditUserEmoji(access: ReturnType<typeof getUserEmojiAccess>, emoji: {
	host: string | null;
	userId: string | null;
}, userId: string): boolean {
	return access.canManage || (access.canManageOwn && emoji.host === null && emoji.userId === userId);
}

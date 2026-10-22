/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { RoleService } from '@/core/RoleService.js';
import { getUserEmojiAccess, canEditUserEmoji } from '@/misc/user-emoji-permissions.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ApiError } from '../../../error.js';
import { CustomEmojiService } from '@/core/CustomEmojiService.js';

export const meta = {
	tags: ['admin'],

	requireCredential: true,
	requiredRolePolicies: ['canManageCustomEmojis', 'canManageUserEmoji'],
	kind: 'write:admin:emoji',

	errors: {
		permissionDenied: {
			message: 'You can only manage your own local emoji.',
			code: 'PERMISSION_DENIED',
			id: '97e15ec7-263a-488b-a8df-c860d0ab08e9',
		},
		noSuchEmoji: {
			message: 'No such emoji.',
			code: 'NO_SUCH_EMOJI',
			id: 'be83669b-773a-44b7-b1f8-e5e5170ac3c2',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		id: { type: 'string', format: 'misskey:id' },
	},
	required: ['id'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private customEmojiService: CustomEmojiService,
		private roleService: RoleService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const policies = await this.roleService.getUserPolicies(me.id);
			const access = getUserEmojiAccess(policies, await this.roleService.isAdministrator(me));
			const emoji = await this.customEmojiService.getEmojiById(ps.id);
			if (emoji == null) throw new ApiError(meta.errors.noSuchEmoji);
			if (!canEditUserEmoji(access, emoji, me.id)) throw new ApiError(meta.errors.permissionDenied);
			await this.customEmojiService.delete(ps.id, me);
		});
	}
}

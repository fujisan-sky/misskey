/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { AvatarDecorationService } from '@/core/AvatarDecorationService.js';
import { RoleService } from '@/core/RoleService.js';
import { ApiError } from '../../../error.js';

export const meta = {
	tags: ['admin'],

	requireCredential: true,
	requiredRolePolicy: 'canManageAvatarDecorations',
	kind: 'write:admin:avatar-decorations',
	errors: {
		noSuchDecoration: {
			message: 'No such avatar decoration.',
			code: 'NO_SUCH_AVATAR_DECORATION',
			id: 'e9c51a11-fe10-4beb-a3d3-674d5d342bf0',
		},
		accessDenied: {
			message: 'You cannot manage this avatar decoration.',
			code: 'ACCESS_DENIED',
			kind: 'permission',
			httpStatusCode: 403,
			id: '9bbc8f1a-6ef2-46d7-9077-12151bafe1ee',
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
		private avatarDecorationService: AvatarDecorationService,
		private roleService: RoleService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const decoration = await this.avatarDecorationService.getAvatarDecorationById(ps.id);
			if (decoration == null) throw new ApiError(meta.errors.noSuchDecoration);
			if (decoration.userId !== me.id && !await this.roleService.isAdministrator(me)) {
				throw new ApiError(meta.errors.accessDenied);
			}

			await this.avatarDecorationService.delete(ps.id, me);
		});
	}
}

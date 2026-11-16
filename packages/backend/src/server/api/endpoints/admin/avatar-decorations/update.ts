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
			id: '8f262690-c652-4443-9de1-63a49ac06728',
		},
		accessDenied: {
			message: 'You cannot manage this avatar decoration.',
			code: 'ACCESS_DENIED',
			kind: 'permission',
			httpStatusCode: 403,
			id: '059d3d10-4ac7-4912-9b75-b0decc35e2d2',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		id: { type: 'string', format: 'misskey:id' },
		name: { type: 'string', minLength: 1 },
		description: { type: 'string' },
		url: { type: 'string', minLength: 1 },
		roleIdsThatCanBeUsedThisDecoration: { type: 'array', items: {
			type: 'string',
		} },
		category: { type: 'string', nullable: true },
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

			await this.avatarDecorationService.update(ps.id, {
				name: ps.name,
				description: ps.description,
				url: ps.url,
				roleIdsThatCanBeUsedThisDecoration: ps.roleIdsThatCanBeUsedThisDecoration,
				category: ps.category,
			}, me);
		});
	}
}

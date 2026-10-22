/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import ms from 'ms';
import { Injectable } from '@nestjs/common';
import { RoleService } from '@/core/RoleService.js';
import { getUserEmojiAccess } from '@/misc/user-emoji-permissions.js';
import { ApiError } from '../error.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { QueueService } from '@/core/QueueService.js';

export const meta = {
	secure: true,
	requireCredential: true,
	limit: {
		duration: ms('1hour'),
		max: 1,
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private queueService: QueueService,
		private roleService: RoleService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const access = getUserEmojiAccess(await this.roleService.getUserPolicies(me.id), await this.roleService.isAdministrator(me));
			if (access.userOnly) throw new ApiError({
				message: 'User emoji permission does not allow exporting emoji.',
				code: 'PERMISSION_DENIED',
				id: 'f3d8be44-d89d-495e-8738-76c29580f842',
				kind: 'permission',
			});
			this.queueService.createExportCustomEmojisJob(me);
		});
	}
}

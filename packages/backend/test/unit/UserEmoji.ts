/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { getUserEmojiAccess, canEditUserEmoji } from '@/misc/user-emoji-permissions.js';
import AddEndpoint, { meta as addMeta } from '@/server/api/endpoints/admin/emoji/add.js';
import UpdateEndpoint from '@/server/api/endpoints/admin/emoji/update.js';
import DeleteEndpoint from '@/server/api/endpoints/admin/emoji/delete.js';
import ExportEndpoint from '@/server/api/endpoints/export-custom-emojis.js';
import ListEndpoint from '@/server/api/endpoints/admin/emoji/list.js';
import { meta as copyMeta } from '@/server/api/endpoints/admin/emoji/copy.js';
import { meta as remoteMeta } from '@/server/api/endpoints/admin/emoji/list-remote.js';

const me = { id: 'owner' } as never;
const userPolicies = { canManageUserEmoji: true, canCreateEmoji: false, canManageCustomEmojis: false };

function fixtures(overrides = {}, administrator = false) {
	const policies = { ...userPolicies, ...overrides };
	const roles = {
		getUserPolicies: vi.fn().mockResolvedValue(policies),
		isAdministrator: vi.fn().mockResolvedValue(administrator),
	};
	const emoji = { id: 'emoji', name: 'test', host: null, userId: 'owner' };
	const files = { findOneBy: vi.fn().mockResolvedValue({ id: 'file', userId: 'owner', type: 'image/png', url: 'https://example.com/image.png' }) };
	const service = {
		add: vi.fn().mockResolvedValue(emoji),
		update: vi.fn().mockResolvedValue(null),
		delete: vi.fn().mockResolvedValue(undefined),
		checkDuplicate: vi.fn().mockResolvedValue(false),
		getEmojiById: vi.fn().mockResolvedValue(emoji),
		getEmojiByName: vi.fn().mockResolvedValue(emoji),
	};
	const entities = { packDetailed: vi.fn().mockResolvedValue(emoji) };
	return { roles, files, service, entities, emoji };
}

describe('User emoji permissions', () => {
	test('only grants editing of owned local emoji; null owners are never owned', () => {
		const access = getUserEmojiAccess(userPolicies, false);
		expect(access.userOnly).toBe(true);
		expect(canEditUserEmoji(access, { host: null, userId: 'owner' }, 'owner')).toBe(true);
		expect(canEditUserEmoji(access, { host: null, userId: 'other' }, 'owner')).toBe(false);
		expect(canEditUserEmoji(access, { host: null, userId: null }, 'owner')).toBe(false);
		expect(canEditUserEmoji(access, { host: 'remote.example', userId: 'owner' }, 'owner')).toBe(false);
	});

	test('administrator and existing management policies take precedence', () => {
		for (const access of [getUserEmojiAccess(userPolicies, true), getUserEmojiAccess({ ...userPolicies, canManageCustomEmojis: true }, false)]) {
			expect(access.userOnly).toBe(false);
			expect(canEditUserEmoji(access, { host: null, userId: null }, 'owner')).toBe(true);
		}
		const creator = getUserEmojiAccess({ ...userPolicies, canCreateEmoji: true }, false);
		expect(creator.userOnly).toBe(false);
		expect(canEditUserEmoji(creator, { host: null, userId: 'other' }, 'owner')).toBe(false);
	});

	test('revoking user policy removes ownership-based access', () => {
		const access = getUserEmojiAccess({ ...userPolicies, canManageUserEmoji: false }, false);
		expect(canEditUserEmoji(access, { host: null, userId: 'owner' }, 'owner')).toBe(false);
	});

	test('user policy enables creation but does not enable remote listing or copying', () => {
		expect(addMeta.requiredRolePolicies).toContain('canManageUserEmoji');
		expect(copyMeta.requiredRolePolicies).not.toContain('canManageUserEmoji');
		expect(remoteMeta.requiredRolePolicies).not.toContain('canManageUserEmoji');
	});
});

describe('User emoji endpoints', () => {
	test('onlyMine filters by the caller on the server before pagination', async () => {
		for (const onlyMine of [false, true]) {
			const query = { andWhere: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), getMany: vi.fn().mockResolvedValue([]) };
			const repository = { createQueryBuilder: vi.fn().mockReturnValue(query) };
			const entities = { packDetailedMany: vi.fn().mockResolvedValue([]) };
			const queries = { makePaginationQuery: vi.fn().mockReturnValue(query) };
			const endpoint = new ListEndpoint(repository as never, entities as never, queries as never);
			await endpoint.exec({ onlyMine, limit: 10 }, me, null);
			expect(query.andWhere).toHaveBeenCalledWith('emoji.host IS NULL');
			if (onlyMine) {
				expect(query.andWhere).toHaveBeenCalledWith('emoji.userId = :userId', { userId: 'owner' });
			} else {
				expect(query.andWhere).toHaveBeenCalledTimes(1);
			}
		}
	});

	test('creation records the caller and overrides restricted fields', async () => {
		const f = fixtures();
		const endpoint = new AddEndpoint(f.files as never, f.service as never, f.roles as never, f.entities as never);
		await endpoint.exec({ name: 'test', fileId: 'file', userId: 'forged', isSensitive: true, localOnly: true, roleIdsThatCanBeUsedThisEmojiAsReaction: ['role'] }, me, null);
		expect(f.service.add).toHaveBeenCalledWith(expect.objectContaining({ userId: 'owner', isSensitive: false, localOnly: true, roleIdsThatCanBeUsedThisEmojiAsReaction: [] }), me);
	});

	test('user creation defaults localOnly to false and accepts an explicit false', async () => {
		for (const params of [{}, { localOnly: false }]) {
			const f = fixtures();
			const endpoint = new AddEndpoint(f.files as never, f.service as never, f.roles as never, f.entities as never);
			await endpoint.exec({ name: 'test', fileId: 'file', ...params }, me, null);
			expect(f.service.add).toHaveBeenCalledWith(expect.objectContaining({ localOnly: false }), me);
		}
	});

	test('user updates can disable localOnly and preserve it when omitted', async () => {
		for (const params of [{ localOnly: false }, {}]) {
			const f = fixtures();
			const endpoint = new UpdateEndpoint(f.files as never, f.service as never, f.roles as never);
			await endpoint.exec({ id: 'emoji', ...params }, me, null);
			expect(f.service.update).toHaveBeenCalledWith(expect.objectContaining({ localOnly: params.localOnly }), me);
		}
	});

	test('creation cannot use another user drive file', async () => {
		const f = fixtures();
		f.files.findOneBy.mockResolvedValue({ id: 'file', userId: 'other', type: 'image/png', url: 'https://example.com/image.png' });
		const endpoint = new AddEndpoint(f.files as never, f.service as never, f.roles as never, f.entities as never);
		await expect(endpoint.exec({ name: 'test', fileId: 'file' }, me, null)).rejects.toMatchObject({ code: 'NO_SUCH_FILE' });
		expect(f.service.add).not.toHaveBeenCalled();
	});

	test('existing creation permission preserves unrestricted creation', async () => {
		const f = fixtures({ canCreateEmoji: true });
		const endpoint = new AddEndpoint(f.files as never, f.service as never, f.roles as never, f.entities as never);
		await endpoint.exec({ name: 'test', fileId: 'file', isSensitive: true, localOnly: true, roleIdsThatCanBeUsedThisEmojiAsReaction: ['role'] }, me, null);
		expect(f.service.add).toHaveBeenCalledWith(expect.objectContaining({ isSensitive: true, localOnly: true, roleIdsThatCanBeUsedThisEmojiAsReaction: ['role'] }), me);
	});

	test('owned updates enforce fixed values and resolve name-based requests to the checked ID', async () => {
		const f = fixtures();
		const endpoint = new UpdateEndpoint(f.files as never, f.service as never, f.roles as never);
		await endpoint.exec({ name: 'test', isSensitive: true, localOnly: true, roleIdsThatCanBeUsedThisEmojiAsReaction: ['role'] }, me, null);
		expect(f.service.update).toHaveBeenCalledWith(expect.objectContaining({ id: 'emoji', isSensitive: false, localOnly: true, roleIdsThatCanBeUsedThisEmojiAsReaction: [] }), me);
	});

	test('updates and deletes reject other owners, unowned emoji and remote emoji', async () => {
		for (const emoji of [{ userId: 'other', host: null }, { userId: null, host: null }, { userId: 'owner', host: 'remote.example' }]) {
			const f = fixtures();
			f.service.getEmojiById.mockResolvedValue({ ...f.emoji, ...emoji } as never);
			const update = new UpdateEndpoint(f.files as never, f.service as never, f.roles as never);
			const del = new DeleteEndpoint(f.service as never, f.roles as never);
			await expect(update.exec({ id: 'emoji' }, me, null)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
			await expect(del.exec({ id: 'emoji' }, me, null)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
			expect(f.service.update).not.toHaveBeenCalled();
			expect(f.service.delete).not.toHaveBeenCalled();
		}
	});

	test('owned deletion succeeds and management can delete other owners', async () => {
		for (const management of [false, true]) {
			const f = fixtures({ canManageCustomEmojis: management });
			if (management) f.service.getEmojiById.mockResolvedValue({ ...f.emoji, userId: 'other' });
			const endpoint = new DeleteEndpoint(f.service as never, f.roles as never);
			await endpoint.exec({ id: 'emoji' }, me, null);
			expect(f.service.delete).toHaveBeenCalledWith('emoji', me);
		}
	});

	test('export is denied for user-only permission and preserved for existing permission', async () => {
		const queue = { createExportCustomEmojisJob: vi.fn() };
		const f = fixtures();
		const endpoint = new ExportEndpoint(queue as never, f.roles as never);
		await expect(endpoint.exec({}, me, null)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
		expect(queue.createExportCustomEmojisJob).not.toHaveBeenCalled();
		const legacy = fixtures({ canCreateEmoji: true });
		await new ExportEndpoint(queue as never, legacy.roles as never).exec({}, me, null);
		expect(queue.createExportCustomEmojisJob).toHaveBeenCalledWith(me);
	});
});

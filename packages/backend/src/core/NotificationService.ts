/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { setTimeout } from 'node:timers/promises';
import * as Redis from 'ioredis';
import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { In } from 'typeorm';
import { ReplyError } from 'ioredis';
import { DI } from '@/di-symbols.js';
import type { MiUserProfile, UsersRepository } from '@/models/_.js';
import type { MiUser } from '@/models/User.js';
import type { MiNotification } from '@/models/Notification.js';
import { bindThis } from '@/decorators.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { PushNotificationService } from '@/core/PushNotificationService.js';
import { NotificationEntityService } from '@/core/entities/NotificationEntityService.js';
import { IdService } from '@/core/IdService.js';
import { CacheService } from '@/core/CacheService.js';
import type { Config } from '@/config.js';
import { EmailService } from '@/core/EmailService.js';
import { UserListService } from '@/core/UserListService.js';
import { FilterUnionByProperty, groupedNotificationTypes, obsoleteNotificationTypes } from '@/types.js';
import { trackPromise } from '@/misc/promise-tracker.js';

@Injectable()
export class NotificationService implements OnApplicationShutdown {
	#shutdownController = new AbortController();

	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.redis)
		private redisClient: Redis.Redis,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		private notificationEntityService: NotificationEntityService,
		private idService: IdService,
		private globalEventService: GlobalEventService,
		private pushNotificationService: PushNotificationService,
		private cacheService: CacheService,
		private emailService: EmailService,
		private userListService: UserListService,
	) {
	}

	@bindThis
	public async readAllNotification(
		userId: MiUser['id'],
		force = false,
	) {
		const latestReadNotificationId = await this.redisClient.get(`latestReadNotification:${userId}`);

		const latestNotificationIdsRes = await this.redisClient.xrevrange(
			`notificationTimeline:${userId}`,
			'+',
			'-',
			'COUNT', 1);
		const latestNotificationId = latestNotificationIdsRes[0]?.[0];

		if (latestNotificationId == null) return;

		this.redisClient.set(`latestReadNotification:${userId}`, latestNotificationId);

		if (force || latestReadNotificationId == null || (latestReadNotificationId < latestNotificationId)) {
			return this.postReadAllNotifications(userId);
		}
	}

	@bindThis
	private postReadAllNotifications(userId: MiUser['id']) {
		this.globalEventService.publishMainStream(userId, 'readAllNotifications');
		this.pushNotificationService.pushNotification(userId, 'readAllNotifications', undefined);
	}

	@bindThis
	public createNotification<T extends MiNotification['type']>(
		notifieeId: MiUser['id'],
		type: T,
		data: Omit<FilterUnionByProperty<MiNotification, 'type', T>, 'type' | 'id' | 'createdAt' | 'notifierId'>,
		notifierId?: MiUser['id'] | null,
	) {
		trackPromise(
			this.#createNotificationInternal(notifieeId, type, data, notifierId),
		);
	}

	async #createNotificationInternal<T extends MiNotification['type']>(
		notifieeId: MiUser['id'],
		type: T,
		data: Omit<FilterUnionByProperty<MiNotification, 'type', T>, 'type' | 'id' | 'createdAt' | 'notifierId'>,
		notifierId?: MiUser['id'] | null,
	): Promise<MiNotification | null> {
		const profile = await this.cacheService.userProfileCache.fetch(notifieeId);

		// 古いMisskeyバージョンのキャッシュが残っている可能性がある
		// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
		const recieveConfig = (profile.notificationRecieveConfig ?? {})[type];
		if (recieveConfig?.type === 'never') {
			return null;
		}

		if (notifierId) {
			if (notifieeId === notifierId) {
				return null;
			}

			const mutings = await this.cacheService.userMutingsCache.fetch(notifieeId);
			if (mutings.has(notifierId)) {
				return null;
			}

			if (recieveConfig?.type === 'following') {
				const isFollowing = await this.cacheService.userFollowingsCache.fetch(notifieeId).then(followings => Object.hasOwn(followings, notifierId));
				if (!isFollowing) {
					return null;
				}
			} else if (recieveConfig?.type === 'follower') {
				const isFollower = await this.cacheService.userFollowingsCache.fetch(notifierId).then(followings => Object.hasOwn(followings, notifieeId));
				if (!isFollower) {
					return null;
				}
			} else if (recieveConfig?.type === 'mutualFollow') {
				const [isFollowing, isFollower] = await Promise.all([
					this.cacheService.userFollowingsCache.fetch(notifieeId).then(followings => Object.hasOwn(followings, notifierId)),
					this.cacheService.userFollowingsCache.fetch(notifierId).then(followings => Object.hasOwn(followings, notifieeId)),
				]);
				if (!(isFollowing && isFollower)) {
					return null;
				}
			} else if (recieveConfig?.type === 'followingOrFollower') {
				const [isFollowing, isFollower] = await Promise.all([
					this.cacheService.userFollowingsCache.fetch(notifieeId).then(followings => Object.hasOwn(followings, notifierId)),
					this.cacheService.userFollowingsCache.fetch(notifierId).then(followings => Object.hasOwn(followings, notifieeId)),
				]);
				if (!isFollowing && !isFollower) {
					return null;
				}
			} else if (recieveConfig?.type === 'list') {
				const isMember = await this.userListService.membersCache.fetch(recieveConfig.userListId).then(members => members.has(notifierId));
				if (!isMember) {
					return null;
				}
			}
		}

		const createdAt = new Date();
		let notification: FilterUnionByProperty<MiNotification, 'type', T>;
		let redisId: string;

		do {
			notification = {
				id: this.idService.gen(),
				createdAt,
				type: type,
				...(notifierId ? {
					notifierId,
				} : {}),
				...data,
			} as unknown as FilterUnionByProperty<MiNotification, 'type', T>;

			try {
				redisId = (await this.redisClient.xadd(
					`notificationTimeline:${notifieeId}`,
					'MAXLEN', '~', this.config.perUserNotificationsMaxCount.toString(),
					this.toXListId(notification.id),
					'data', JSON.stringify(notification)))!;
			} catch (e) {
				// The ID specified in XADD is equal or smaller than the target stream top item で失敗することがあるのでリトライ
				if (e instanceof ReplyError) continue;
				throw e;
			}

			break;
			// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
		} while (true);

		const packed = await this.notificationEntityService.pack(notification, notifieeId, {});

		if (packed == null) return null;

		// Publish notification event
		this.globalEventService.publishMainStream(notifieeId, 'notification', packed);

		// 2秒経っても(今回作成した)通知が既読にならなかったら「未読の通知がありますよ」イベントを発行する
		// テスト通知の場合は即時発行
		const interval = notification.type === 'test' ? 0 : 2000;
		setTimeout(interval, 'unread notification', { signal: this.#shutdownController.signal }).then(async () => {
			const latestReadNotificationId = await this.redisClient.get(`latestReadNotification:${notifieeId}`);
			if (latestReadNotificationId && (latestReadNotificationId >= redisId)) return;

			this.globalEventService.publishMainStream(notifieeId, 'unreadNotification', packed);
			this.pushNotificationService.pushNotification(notifieeId, 'notification', packed);

		}, () => { /* aborted, ignore it */ });

		void this.sendEmailNotification(profile, type, notifierId).catch((err) => {
			console.error(
       			`メール通知の送信に失敗しました: type=${type}, notifieeId=${notifieeId}`,
       			err,
			);
		});

		return notification;
	}

	// TODO
	//const locales = await import('i18n');

	// TODO: locale ファイルをクライアント用とサーバー用で分けたい


	@bindThis
	private async sendEmailNotification(
    		profile: MiUserProfile,
    		type: MiNotification['type'],
    		notifierId?: MiUser['id'] | null,
	): Promise<void> {
    		if (!profile.email || !profile.emailVerified || !notifierId) {
        		return;
    		}

    		let settingType: string;
    		let title: string;
    		let message: string;

    		switch (type) {
        		case 'mention':
            			settingType = 'mention';
            			title = 'メンション／ダイレクトメッセージが来ています';
            			message = 'さんからメンション／ダイレクトメッセージが来ています';
            		break;

        		case 'reply':
            			settingType = 'reply';
            			title = 'リプライされました';
            			message = 'さんからリプライが来ています';
            		break;

        		case 'quote':
            			settingType = 'quote';
            			title = '引用されました';
            			message = 'さんに引用されました';
            		break;

        		case 'renote':
            			settingType = 'renote';
            			title = 'リノートされました';
            			message = 'さんにリノートされました';
            		break;

        		case 'follow':
            			settingType = 'follow';
            			title = 'フォローされました';
            			message = 'さんにフォローされました';
            		break;

        		case 'receiveFollowRequest':
            			settingType = 'receiveFollowRequest';
            			title = 'フォローリクエストが届いています';
            			message = 'さんからフォローリクエストが届いています';
            		break;

        		default:
            			return;
    		}

		// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    		const emailNotificationTypes =
        		profile.emailNotificationTypes ?? [];
		
    		if (!emailNotificationTypes.includes(settingType)) {
        		return;
    		}

    		// 設定を確認してからDB検索する
    		const notifier = await this.usersRepository.findOneBy({
        		id: notifierId,
    		});

    		// 通知作成からメール処理までの間に削除された場合など
    		if (!notifier) {
        		return;
    		}

    		await this.emailNotificationEtc(
        		profile.email,
        		notifier,
        		title,
        		message,
    		);
	}

	@bindThis
	private async emailNotificationEtc(
    		mailAddr: string,
    		notifier: MiUser,
    		title: string,
    		message: string,
	): Promise<void> {
    		const nameText = notifier.name || notifier.username;
    		const hostName = notifier.host ?? this.config.host;
    		const accountText =
        		`@${notifier.username}@${hostName}`;

    		const escapedName = this.escapeHtml(nameText);
    		const escapedAccount = this.escapeHtml(accountText);
    		const escapedMessage = this.escapeHtml(message);

    		const plainText =
        		`${nameText} さん\n` +
        		`${accountText}\n\n` +
        		`${nameText}${message}`;

    		const htmlText = `
<div>
	<strong style="font-size: 1.3em;">
       		${escapedName} さん
       	</strong>
       	<br>
       	<i>${escapedAccount}</i>
       	<p>${escapedName}${escapedMessage}</p>
</div>
`;

    		await this.emailService.sendEmail(
        		mailAddr,
        		title,
        		htmlText,
        		plainText,
    		);
	}

	private escapeHtml(value: string): string {
    		const chars: Record<string, string> = {
        		'&': '&amp;',
        		'<': '&lt;',
        		'>': '&gt;',
        		'"': '&quot;',
        		"'": '&#39;',
    		};

    		return value.replace(/[&<>"']/g, char => chars[char]);
	}

	@bindThis
	public async flushAllNotifications(userId: MiUser['id']) {
		await Promise.all([
			this.redisClient.del(`notificationTimeline:${userId}`),
			this.redisClient.del(`latestReadNotification:${userId}`),
		]);
		this.globalEventService.publishMainStream(userId, 'notificationFlushed');
	}

	@bindThis
	public dispose(): void {
		this.#shutdownController.abort();
	}

	private toXListId(id: string): string {
		const { date, additional } = this.idService.parseFull(id);
		// Redis Stream sequenceはunit64制約があるため、収まらない場合は下位64bitを取る
		return date.toString() + '-' + BigInt.asUintN(64, additional).toString();
	}

	@bindThis
	public async getNotifications(
		userId: MiUser['id'],
		{
			sinceId,
			untilId,
			limit = 20,
			includeTypes,
			excludeTypes,
		}: {
			sinceId?: string,
			untilId?: string,
			limit?: number,
			// any extra types are allowed, those are no-op
			includeTypes?: (MiNotification['type'] | string)[],
			excludeTypes?: (MiNotification['type'] | string)[],
		},
	): Promise<MiNotification[]> {
		let sinceTime = sinceId ? this.toXListId(sinceId) : null;
		let untilTime = untilId ? this.toXListId(untilId) : null;

		let notifications: MiNotification[];
		for (; ;) {
			let notificationsRes: [id: string, fields: string[]][];

			// sinceidのみの場合は古い順、そうでない場合は新しい順。 QueryService.makePaginationQueryも参照
			if (sinceTime && !untilTime) {
				notificationsRes = await this.redisClient.xrange(
					`notificationTimeline:${userId}`,
					'(' + sinceTime,
					'+',
					'COUNT', limit);
			} else {
				notificationsRes = await this.redisClient.xrevrange(
					`notificationTimeline:${userId}`,
					untilTime ? '(' + untilTime : '+',
					sinceTime ? '(' + sinceTime : '-',
					'COUNT', limit);
			}

			if (notificationsRes.length === 0) {
				return [];
			}

			notifications = notificationsRes.map(x => JSON.parse(x[1][1])) as MiNotification[];

			if (includeTypes && includeTypes.length > 0) {
				notifications = notifications.filter(notification => includeTypes.includes(notification.type));
			} else if (excludeTypes && excludeTypes.length > 0) {
				notifications = notifications.filter(notification => !excludeTypes.includes(notification.type));
			}

			if (notifications.length !== 0) {
				// 通知が１件以上ある場合は返す
				break;
			}

			// フィルタしたことで通知が0件になった場合、次のページを取得する
			if (sinceId && !untilId) {
				sinceTime = notificationsRes[notificationsRes.length - 1][0];
			} else {
				untilTime = notificationsRes[notificationsRes.length - 1][0];
			}
		}

		return notifications;
	}

	@bindThis
	public onApplicationShutdown(signal?: string | undefined): void {
		this.dispose();
	}
}

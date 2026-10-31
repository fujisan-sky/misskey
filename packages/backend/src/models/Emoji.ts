/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { PrimaryColumn, Entity, Index, Column, ManyToOne, JoinColumn } from 'typeorm';
import { id } from './util/id.js';
import { MiUser } from './User.js';

@Entity('emoji')
@Index(['name', 'host'], { unique: true })
@Index('IDX_EMOJI_ROLE_IDS', { synchronize: false }) // GIN for roleIdsThatCanBeUsedThisEmojiAsReaction in production
export class MiEmoji {
	@PrimaryColumn(id())
	public id: string;

	@Index('IDX_emoji_userId')
	@Column({ ...id(), nullable: true })
	public userId: MiUser['id'] | null;

	@ManyToOne(() => MiUser, { nullable: true, onDelete: 'SET NULL' })
	@JoinColumn({ foreignKeyConstraintName: 'FK_emoji_userId' })
	public user: MiUser | null;

	@Column('timestamp with time zone', {
		nullable: true,
	})
	public updatedAt: Date | null;

	@Index()
	@Column('varchar', {
		length: 128,
	})
	public name: string;

	@Index()
	@Column('varchar', {
		length: 128, nullable: true,
	})
	public host: string | null;

	@Column('varchar', {
		length: 128, nullable: true,
	})
	@Index('IDX_EMOJI_CATEGORY')
	public category: string | null;

	@Column('varchar', {
		length: 512,
	})
	public originalUrl: string;

	@Column('varchar', {
		length: 512,
		default: '',
	})
	public publicUrl: string;

	@Column('varchar', {
		length: 512, nullable: true,
	})
	public uri: string | null;

	// publicUrlの方のtypeが入る
	@Column('varchar', {
		length: 64, nullable: true,
	})
	public type: string | null;

	@Column('varchar', {
		array: true, length: 128, default: '{}',
	})
	public aliases: string[];

	@Column('varchar', {
		length: 1024, nullable: true,
	})
	public license: string | null;

	@Column('boolean', {
		default: false,
	})
	public localOnly: boolean;

	@Column('boolean', {
		default: false,
	})
	public isSensitive: boolean;

	// TODO: 定期ジョブで存在しなくなったロールIDを除去するようにする
	@Column('varchar', {
		array: true, length: 128, default: '{}',
	})
	public roleIdsThatCanBeUsedThisEmojiAsReaction: string[];
}

/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class UserEmoji1792381111000 {
	name = 'UserEmoji1792381111000';

	async up(queryRunner) {
		await queryRunner.query('ALTER TABLE "emoji" ADD "userId" character varying(32)');
		await queryRunner.query('CREATE INDEX "IDX_emoji_userId" ON "emoji" ("userId")');
		await queryRunner.query('ALTER TABLE "emoji" ADD CONSTRAINT "FK_emoji_userId" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE NO ACTION');
	}

	async down(queryRunner) {
		await queryRunner.query('ALTER TABLE "emoji" DROP CONSTRAINT "FK_emoji_userId"');
		await queryRunner.query('DROP INDEX "IDX_emoji_userId"');
		await queryRunner.query('ALTER TABLE "emoji" DROP COLUMN "userId"');
	}
}

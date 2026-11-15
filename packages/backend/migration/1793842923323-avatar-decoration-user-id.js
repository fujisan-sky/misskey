/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class AvatarDecorationUserId1793842923323 {
    name = 'AvatarDecorationUserId1793842923323'

    async up(queryRunner) {
        await queryRunner.query(`ALTER TABLE "avatar_decoration" ADD "userId" character varying(32)`);
        // Only the audited legacy format is recognized. Remove at most one separator space.
        await queryRunner.query(`
            UPDATE "avatar_decoration" AS decoration
            SET "userId" = (
                SELECT "id" FROM "user"
                WHERE "id" = split_part(decoration."description", '#', 1)
            ),
            "description" = substring(decoration."description" FROM
                strpos(decoration."description", '#') + 1 +
                CASE WHEN substring(decoration."description" FROM
                    strpos(decoration."description", '#') + 1 FOR 1) = ' ' THEN 1 ELSE 0 END)
            WHERE decoration."description" ~ '^[A-Za-z0-9]{8,15}#'
        `);
        await queryRunner.query(`ALTER TABLE "avatar_decoration" ADD CONSTRAINT "FK_avatar_decoration_userId" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    }

    async down(queryRunner) {
        // Lossy rollback: unknown/deleted owners cannot be recovered; truncate excess text.
        await queryRunner.query(`UPDATE "avatar_decoration" SET "description" = left("userId" || '# ' || "description", 2048) WHERE "userId" IS NOT NULL`);
        await queryRunner.query(`ALTER TABLE "avatar_decoration" DROP CONSTRAINT "FK_avatar_decoration_userId"`);
        await queryRunner.query(`ALTER TABLE "avatar_decoration" DROP COLUMN "userId"`);
    }
}

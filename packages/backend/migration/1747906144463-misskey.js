export class Misskey1747906144463 {
    name = 'Misskey1747906144463'

    async up(queryRunner) {
        await queryRunner.query(`ALTER TABLE "user" ADD "safemode" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`COMMENT ON COLUMN "user"."safemode" IS 'Whether the User is safemode(under 12).'`);
    }

    async down(queryRunner) {
        await queryRunner.query(`COMMENT ON COLUMN "user"."safemode" IS 'Whether the User is safemode(under 12).'`);
        await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "safemode"`);
    }
}

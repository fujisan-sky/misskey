import { MigrationInterface, QueryRunner } from "typeorm";

export class ChangeEmailNotificationTypesDefault1783070482891 implements MigrationInterface {
	async up(queryRunner) {
		await queryRunner.query(
			`ALTER TABLE "user_profile" ALTER COLUMN "emailNotificationTypes" SET DEFAULT '["mention","reply","quote","follow","receiveFollowRequest"]'`,
		);
	}

	async down(queryRunner) {
		await queryRunner.query(
			`ALTER TABLE "user_profile" ALTER COLUMN "emailNotificationTypes" SET DEFAULT '["follow","receiveFollowRequest"]'`,
		);
	}

}

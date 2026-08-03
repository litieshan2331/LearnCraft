-- LearnCraft 学习目标主题迁移：将固定 Python 标识改为用户可填写的自由主题，并保留已有目标。
ALTER TABLE "learning_goals" RENAME COLUMN "subject_key" TO "topic";--> statement-breakpoint
ALTER TABLE "learning_goals" ALTER COLUMN "topic" SET DATA TYPE varchar(200);--> statement-breakpoint
ALTER TABLE "learning_goals" DROP CONSTRAINT "ck_learning_goals_subject";--> statement-breakpoint
UPDATE "learning_goals" SET "topic" = 'Python 3.11 基础' WHERE "topic" = 'python-311-basics';--> statement-breakpoint
ALTER TABLE "learning_goals" ADD CONSTRAINT "ck_learning_goals_topic" CHECK (length(btrim("learning_goals"."topic")) between 1 and 200);

-- S4-1：选题评分与审核状态机
-- 1) Angle 增审核态 status / 审核轮数 reviewRound / 评分 metaJson（DATABASE-DESIGN-REVIEW §③ 附加字段）
-- 2) 新表 TopicReview 审核事件流水（D1：Angle.status + used + TopicReview，不建 TopicCandidate）
-- 3) 索引演进：[trackId,used,seq] → [trackId,status,seq]（§③ 明示）
--
-- 人工审查说明：
-- - 默认值 status='candidate'：一切选题（含未来任何存量）进候选，不伪装成已审核（任务书 §三）。
-- - reviewedBy 为操作者登录名（非审批流/角色机制）；promptVersionHash / contractVersion 因
--   S3 裁决 PromptVersion / TrackContract 不实施而暂缺（不伪造追溯）。
-- - prisma migrate diff 原始输出含一行 `article.contentWechat` MODIFY 漂移（dbgenerated ('') 表示法
--   与内省表示法差异，非真实变更），已从本迁移剔除——与 S4-1 无关，避免混入无关 DDL。

-- DropIndex
DROP INDEX `Angle_trackId_used_seq_idx` ON `Angle`;

-- AlterTable
ALTER TABLE `Angle` ADD COLUMN `metaJson` JSON NULL,
    ADD COLUMN `reviewRound` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `status` ENUM('candidate', 'needs_revision', 'approved', 'rejected') NOT NULL DEFAULT 'candidate';

-- CreateTable
CREATE TABLE `TopicReview` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `angleId` INTEGER NOT NULL,
    `round` INTEGER NOT NULL,
    `scoresJson` JSON NULL,
    `riskHits` JSON NULL,
    `dupHits` JSON NULL,
    `verdict` ENUM('approved', 'needs_revision', 'rejected') NOT NULL,
    `reason` VARCHAR(500) NOT NULL DEFAULT '',
    `model` VARCHAR(64) NOT NULL DEFAULT '',
    `reviewedBy` VARCHAR(64) NOT NULL DEFAULT '',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `TopicReview_angleId_round_idx`(`angleId`, `round`),
    INDEX `TopicReview_verdict_createdAt_idx`(`verdict`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `Angle_trackId_status_seq_idx` ON `Angle`(`trackId`, `status`, `seq`);

-- AddForeignKey
ALTER TABLE `TopicReview` ADD CONSTRAINT `TopicReview_angleId_fkey` FOREIGN KEY (`angleId`) REFERENCES `Angle`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

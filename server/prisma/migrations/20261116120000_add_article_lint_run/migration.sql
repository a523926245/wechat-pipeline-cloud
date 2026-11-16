-- S4-3：成稿体检（lint）结果落库
--
-- 为什么新建表而不是复用 Article.qualityJson（死字段）/Article.note：
--   ① 体检是「一次执行一个结论」，追溯要求保留各次结果；塞进单列 Json 只能留最后一次，
--      下一次检查就把上一次覆盖掉，等于没有历史（这正是 qualityJson 的教训）。
--   ② 快照语义：statsJson / issuesJson 是检查当时的原样拷贝，规则改动不回溯旧行。
--   ③ 一篇文章 N 条记录，天然的外键子表，随文章级联删除，不产生孤儿行。
--
-- 人工审查要点：
-- - 纯新增表 + 索引 + 级联外键，**不改任何既有列**，对现有创作/审核/排产/推送链路零影响。
-- - 只记录，不参与任何业务判定：推送门禁仍以 publisher 现算的 LintReport 为准（本表是留痕，不是真源）。
-- - 历史文章没有体检记录时如实显示「无记录」，不回填、不伪造（章程序言：legacy 不得伪造追溯）。

-- CreateTable
CREATE TABLE `ArticleLintRun` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `articleId` INTEGER NOT NULL,
    `trigger` VARCHAR(16) NOT NULL,
    `ok` BOOLEAN NOT NULL,
    `errorCount` INTEGER NOT NULL DEFAULT 0,
    `warnCount` INTEGER NOT NULL DEFAULT 0,
    `statsJson` JSON NULL,
    `issuesJson` JSON NULL,
    `ruleJson` JSON NULL,
    `contentHash` VARCHAR(64) NOT NULL DEFAULT '',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ArticleLintRun_articleId_createdAt_idx`(`articleId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ArticleLintRun` ADD CONSTRAINT `ArticleLintRun_articleId_fkey` FOREIGN KEY (`articleId`) REFERENCES `Article`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

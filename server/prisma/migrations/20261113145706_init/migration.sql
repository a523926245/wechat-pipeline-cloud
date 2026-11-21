-- CreateTable
CREATE TABLE `Track` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(32) NOT NULL,
    `slug` VARCHAR(64) NOT NULL,
    `quotaPerDay` INTEGER NOT NULL DEFAULT 2,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Track_slug_key`(`slug`),
    INDEX `Track_enabled_idx`(`enabled`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TrackPipeline` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `trackId` INTEGER NOT NULL,
    `kind` VARCHAR(16) NOT NULL,
    `quotaPerDay` INTEGER NOT NULL DEFAULT 0,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `configJson` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `TrackPipeline_enabled_idx`(`enabled`),
    UNIQUE INDEX `TrackPipeline_trackId_kind_key`(`trackId`, `kind`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Account` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `trackId` INTEGER NOT NULL,
    `ownerUserId` INTEGER NULL,
    `name` VARCHAR(64) NOT NULL,
    `appid` VARCHAR(32) NOT NULL,
    `secretEnc` LONGBLOB NULL,
    `secretMask` VARCHAR(64) NOT NULL DEFAULT '',
    `author` VARCHAR(64) NOT NULL DEFAULT '',
    `credStatus` ENUM('ok', 'placeholder', 'missing', 'invalid') NOT NULL DEFAULT 'missing',
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Account_appid_key`(`appid`),
    INDEX `Account_trackId_enabled_idx`(`trackId`, `enabled`),
    INDEX `Account_ownerUserId_idx`(`ownerUserId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `User` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `username` VARCHAR(64) NOT NULL,
    `passwordHash` VARCHAR(255) NOT NULL,
    `role` ENUM('admin', 'member', 'guest') NOT NULL DEFAULT 'guest',
    `status` ENUM('pending', 'active', 'disabled') NOT NULL DEFAULT 'pending',
    `expiresAt` DATETIME(3) NULL,
    `maxOAAccounts` INTEGER NOT NULL DEFAULT 1,
    `automationMode` VARCHAR(24) NOT NULL DEFAULT 'manual',
    `writeTime` VARCHAR(5) NOT NULL DEFAULT '06:00',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `User_username_key`(`username`),
    INDEX `User_status_role_idx`(`status`, `role`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `UserSession` (
    `id` VARCHAR(64) NOT NULL,
    `userId` INTEGER NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `UserSession_userId_idx`(`userId`),
    INDEX `UserSession_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `WechatToken` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `accountId` INTEGER NOT NULL,
    `tokenEnc` LONGBLOB NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `WechatToken_accountId_key`(`accountId`),
    INDEX `WechatToken_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Angle` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `trackId` INTEGER NOT NULL,
    `code` VARCHAR(32) NOT NULL,
    `seq` INTEGER NOT NULL,
    `theme` VARCHAR(64) NOT NULL,
    `content` VARCHAR(500) NOT NULL,
    `scope` VARCHAR(16) NOT NULL DEFAULT 'article',
    `used` BOOLEAN NOT NULL DEFAULT false,
    `usedBy` VARCHAR(64) NOT NULL DEFAULT '',
    `usedById` INTEGER NULL,
    `usedByAccountId` INTEGER NULL,
    `usedDate` VARCHAR(10) NULL,
    `source` VARCHAR(64) NOT NULL DEFAULT '',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Angle_trackId_scope_used_seq_idx`(`trackId`, `scope`, `used`, `seq`),
    INDEX `Angle_trackId_used_seq_idx`(`trackId`, `used`, `seq`),
    INDEX `Angle_theme_idx`(`theme`),
    UNIQUE INDEX `Angle_trackId_code_key`(`trackId`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Article` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `trackId` INTEGER NULL,
    `accountId` INTEGER NULL,
    `angleId` INTEGER NULL,
    `title` VARCHAR(255) NOT NULL,
    `digest` VARCHAR(255) NOT NULL DEFAULT '',
    `contentHtml` TEXT NOT NULL,
    `contentWechat` LONGTEXT NOT NULL DEFAULT (''),
    `contentPath` VARCHAR(255) NOT NULL DEFAULT '',
    `coverPath` VARCHAR(255) NOT NULL DEFAULT '',
    `coverMediaId` VARCHAR(128) NOT NULL DEFAULT '',
    `coverUploaded` VARCHAR(255) NOT NULL DEFAULT '',
    `mediaId` VARCHAR(128) NOT NULL DEFAULT '',
    `status` ENUM('draft', 'pushed', 'updated', 'failed') NOT NULL DEFAULT 'draft',
    `pushDate` VARCHAR(10) NOT NULL,
    `blocks` INTEGER NOT NULL DEFAULT 0,
    `chars` INTEGER NOT NULL DEFAULT 0,
    `qualityJson` JSON NULL,
    `pipeline` VARCHAR(16) NOT NULL DEFAULT 'article',
    `comicJson` JSON NULL,
    `idempotencyKey` VARCHAR(128) NOT NULL,
    `note` VARCHAR(500) NOT NULL DEFAULT '',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Article_idempotencyKey_key`(`idempotencyKey`),
    INDEX `Article_pushDate_accountId_idx`(`pushDate`, `accountId`),
    INDEX `Article_status_idx`(`status`),
    INDEX `Article_angleId_idx`(`angleId`),
    INDEX `Article_pipeline_status_idx`(`pipeline`, `status`),
    INDEX `Article_accountId_pipeline_idx`(`accountId`, `pipeline`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ComicPanel` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `articleId` INTEGER NOT NULL,
    `seq` INTEGER NOT NULL,
    `prompt` VARCHAR(2000) NOT NULL,
    `lines` VARCHAR(1000) NOT NULL DEFAULT '',
    `filePath` VARCHAR(255) NOT NULL DEFAULT '',
    `wechatUrl` VARCHAR(512) NOT NULL DEFAULT '',
    `uploadedKey` VARCHAR(255) NOT NULL DEFAULT '',
    `status` VARCHAR(16) NOT NULL DEFAULT 'pending',
    `bytes` INTEGER NOT NULL DEFAULT 0,
    `attempt` INTEGER NOT NULL DEFAULT 0,
    `errorMsg` VARCHAR(500) NOT NULL DEFAULT '',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ComicPanel_articleId_status_idx`(`articleId`, `status`),
    INDEX `ComicPanel_status_updatedAt_idx`(`status`, `updatedAt`),
    UNIQUE INDEX `ComicPanel_articleId_seq_key`(`articleId`, `seq`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TaskRun` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `jobType` ENUM('plan', 'write', 'cover', 'comic_script', 'comic_panel', 'push', 'expand_angles', 'test_connection') NOT NULL,
    `status` ENUM('pending', 'running', 'success', 'failed', 'canceled') NOT NULL DEFAULT 'pending',
    `trigger` ENUM('manual', 'schedule', 'api') NOT NULL DEFAULT 'manual',
    `parentId` INTEGER NULL,
    `trackId` INTEGER NULL,
    `accountId` INTEGER NULL,
    `articleId` INTEGER NULL,
    `angleId` INTEGER NULL,
    `runDate` VARCHAR(10) NOT NULL,
    `attempt` INTEGER NOT NULL DEFAULT 1,
    `paramsJson` JSON NULL,
    `resultJson` JSON NULL,
    `errorCode` VARCHAR(32) NOT NULL DEFAULT '',
    `errorMessage` VARCHAR(1000) NOT NULL DEFAULT '',
    `tokensPrompt` INTEGER NOT NULL DEFAULT 0,
    `tokensComplete` INTEGER NOT NULL DEFAULT 0,
    `startedAt` DATETIME(3) NULL,
    `finishedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `TaskRun_status_createdAt_idx`(`status`, `createdAt`),
    INDEX `TaskRun_jobType_runDate_idx`(`jobType`, `runDate`),
    INDEX `TaskRun_articleId_idx`(`articleId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `RunLog` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `taskRunId` INTEGER NULL,
    `level` ENUM('debug', 'info', 'warn', 'error') NOT NULL DEFAULT 'info',
    `stage` VARCHAR(64) NOT NULL DEFAULT '',
    `message` VARCHAR(2000) NOT NULL,
    `contextJson` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `RunLog_taskRunId_createdAt_idx`(`taskRunId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `LlmModel` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(64) NOT NULL,
    `vendor` VARCHAR(32) NOT NULL DEFAULT 'custom',
    `protocol` ENUM('openai_chat', 'openai_images', 'agnes_image', 'modelscope_qwen_image', 'anthropic_messages', 'openai_video') NOT NULL,
    `capability` ENUM('text', 'image', 'video', 'multimodal') NOT NULL,
    `baseUrl` VARCHAR(255) NOT NULL,
    `modelId` VARCHAR(128) NOT NULL,
    `apiKeyEnc` LONGBLOB NULL,
    `apiKeyMask` VARCHAR(64) NOT NULL DEFAULT '',
    `paramsJson` JSON NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `LlmModel_capability_enabled_idx`(`capability`, `enabled`),
    INDEX `LlmModel_protocol_idx`(`protocol`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ModelBinding` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `role` ENUM('write', 'revise', 'cover', 'expand_angles', 'comic_script', 'comic_panel') NOT NULL,
    `modelId` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ModelBinding_role_key`(`role`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Setting` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `k` VARCHAR(64) NOT NULL,
    `v` VARCHAR(2000) NOT NULL,
    `kind` VARCHAR(16) NOT NULL DEFAULT 'string',
    `readonly` BOOLEAN NOT NULL DEFAULT false,
    `desc` VARCHAR(255) NOT NULL DEFAULT '',
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Setting_k_key`(`k`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `StylePrompt` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `key` VARCHAR(64) NOT NULL,
    `kind` VARCHAR(16) NOT NULL DEFAULT 'track',
    `prompt` TEXT NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `StylePrompt_key_key`(`key`),
    INDEX `StylePrompt_kind_idx`(`kind`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `TrackPipeline` ADD CONSTRAINT `TrackPipeline_trackId_fkey` FOREIGN KEY (`trackId`) REFERENCES `Track`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Account` ADD CONSTRAINT `Account_trackId_fkey` FOREIGN KEY (`trackId`) REFERENCES `Track`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Account` ADD CONSTRAINT `Account_ownerUserId_fkey` FOREIGN KEY (`ownerUserId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `UserSession` ADD CONSTRAINT `UserSession_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `WechatToken` ADD CONSTRAINT `WechatToken_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Angle` ADD CONSTRAINT `Angle_trackId_fkey` FOREIGN KEY (`trackId`) REFERENCES `Track`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Article` ADD CONSTRAINT `Article_trackId_fkey` FOREIGN KEY (`trackId`) REFERENCES `Track`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Article` ADD CONSTRAINT `Article_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Article` ADD CONSTRAINT `Article_angleId_fkey` FOREIGN KEY (`angleId`) REFERENCES `Angle`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ComicPanel` ADD CONSTRAINT `ComicPanel_articleId_fkey` FOREIGN KEY (`articleId`) REFERENCES `Article`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RunLog` ADD CONSTRAINT `RunLog_taskRunId_fkey` FOREIGN KEY (`taskRunId`) REFERENCES `TaskRun`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ModelBinding` ADD CONSTRAINT `ModelBinding_modelId_fkey` FOREIGN KEY (`modelId`) REFERENCES `LlmModel`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

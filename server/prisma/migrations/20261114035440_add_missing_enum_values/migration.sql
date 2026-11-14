-- AlterTable
ALTER TABLE `LlmModel` MODIFY `protocol` ENUM('openai_chat', 'openai_images', 'agnes_image', 'modelscope_qwen_image', 'modelscope_qwen_image_mcp', 'anthropic_messages', 'openai_video') NOT NULL;

-- AlterTable
ALTER TABLE `ModelBinding` MODIFY `role` ENUM('write', 'revise', 'cover', 'expand_angles', 'comic_script', 'comic_panel', 'comic_panel_fallback') NOT NULL;

UPDATE `threads`
SET `environment_id` = (
  SELECT `environment_id`
  FROM `thread_environment_attachments`
  WHERE `thread_environment_attachments`.`thread_id` = `threads`.`id`
)
WHERE EXISTS (
  SELECT 1
  FROM `thread_environment_attachments`
  WHERE `thread_environment_attachments`.`thread_id` = `threads`.`id`
);

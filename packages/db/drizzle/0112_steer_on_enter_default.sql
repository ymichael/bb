INSERT INTO `app_settings_values` (`key`, `value`, `updated_at`)
SELECT 'steerActiveThreadOnEnter', 'false', CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE NOT EXISTS (
    SELECT 1 FROM `app_settings_values` WHERE `key` = 'steerActiveThreadOnEnter'
  )
  AND (
    EXISTS (SELECT 1 FROM `app_settings_values`)
    OR EXISTS (SELECT 1 FROM `projects` WHERE `kind` != 'personal')
    OR EXISTS (SELECT 1 FROM `threads`)
  );

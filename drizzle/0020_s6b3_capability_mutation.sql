DROP TRIGGER `runner_capability_reports_validate_before_insert`;--> statement-breakpoint
CREATE TRIGGER `runner_capability_reports_validate_before_insert`
BEFORE INSERT ON `runner_capability_reports`
BEGIN
	SELECT CASE WHEN
		length(NEW.`report_id`) <> 36
		OR substr(NEW.`report_id`, 1, 4) <> 'cap_'
		OR substr(NEW.`report_id`, 5) GLOB '*[^0-9a-f]*'
		OR length(NEW.`request_hash`) <> 64
		OR NEW.`request_hash` GLOB '*[^0-9a-f]*'
		OR length(NEW.`declaration_hash`) <> 64
		OR NEW.`declaration_hash` GLOB '*[^0-9a-f]*'
		OR NEW.`schema_version` <> 1
		OR NEW.`platform_os` NOT IN (
			'aix', 'darwin', 'freebsd', 'linux', 'openbsd', 'sunos', 'win32'
		)
		OR NEW.`platform_arch` NOT IN (
			'arm', 'arm64', 'ia32', 'loong64', 'mips', 'mipsel', 'ppc',
			'ppc64', 'riscv64', 's390', 's390x', 'x64'
		)
		OR length(CAST(NEW.`node_version` AS BLOB)) NOT BETWEEN 1 AND 64
		OR substr(NEW.`node_version`, 1, 1) <> 'v'
		OR NEW.`node_version` GLOB '*[^0-9A-Za-z.-]*'
		OR length(NEW.`collected_at`) <> 24
		OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.`collected_at`)
			IS NOT NEW.`collected_at`
		OR length(NEW.`received_at`) <> 24
		OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.`received_at`)
			IS NOT NEW.`received_at`
		OR NEW.`received_at` < COALESCE((
			SELECT report.`received_at`
			FROM `runner_capability_reports` report
			WHERE report.`organization_id` = NEW.`organization_id`
				AND report.`runner_id` = NEW.`runner_id`
			ORDER BY report.`received_at` DESC, report.`report_id` DESC
			LIMIT 1
		), NEW.`received_at`)
		OR NEW.`truncated` NOT IN (0, 1)
		OR NEW.`response_status` <> 201
		OR NEW.`response_body` IS NULL
		OR NEW.`replay_count` <> 0
		OR NEW.`compacted_at` IS NOT NULL
		OR NOT EXISTS (
			SELECT 1
			FROM `runners` runner
			INNER JOIN `principals` principal
				ON principal.`id` = runner.`principal_id`
				AND principal.`organization_id` = runner.`organization_id`
			WHERE runner.`id` = NEW.`runner_id`
				AND runner.`organization_id` = NEW.`organization_id`
				AND runner.`status` = 'active'
				AND principal.`kind` = 'runner'
				AND principal.`status` = 'active'
		)
	THEN RAISE(ABORT, 'invalid_capability_report') END;
END;

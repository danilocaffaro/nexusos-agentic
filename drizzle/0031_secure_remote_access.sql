CREATE TABLE `auth_credentials` (
	`principal_id` text PRIMARY KEY NOT NULL,
	`login` text NOT NULL,
	`display_name` text NOT NULL,
	`password_salt` text NOT NULL,
	`password_hash` text NOT NULL,
	`password_iterations` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `auth_credentials_login_length` CHECK(length(`login`) BETWEEN 3 AND 128),
	CONSTRAINT `auth_credentials_display_name_length` CHECK(length(`display_name`) BETWEEN 2 AND 120),
	CONSTRAINT `auth_credentials_password_iterations` CHECK(`password_iterations` >= 600000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_credentials_login_uidx` ON `auth_credentials` (`login`);
--> statement-breakpoint
CREATE TABLE `auth_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`principal_id` text NOT NULL,
	`user_agent_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`revoked_at` text,
	CONSTRAINT `auth_sessions_token_hash_length` CHECK(length(`token_hash`) = 43),
	CONSTRAINT `auth_sessions_time_order` CHECK(julianday(`expires_at`) > julianday(`created_at`))
);
--> statement-breakpoint
CREATE INDEX `auth_sessions_principal_expiry_idx` ON `auth_sessions` (`principal_id`,`expires_at`);
--> statement-breakpoint
CREATE TABLE `auth_login_state` (
	`login` text PRIMARY KEY NOT NULL,
	`failure_count` integer NOT NULL,
	`window_started_at` text NOT NULL,
	`blocked_until` text,
	CONSTRAINT `auth_login_state_failure_count` CHECK(`failure_count` BETWEEN 1 AND 1000)
);
--> statement-breakpoint
CREATE TABLE `auth_events` (
	`id` text PRIMARY KEY NOT NULL,
	`principal_id` text NOT NULL,
	`event_type` text NOT NULL,
	`occurred_at` text NOT NULL,
	CONSTRAINT `auth_events_type` CHECK(`event_type` IN (
		'activation_rejected',
		'activation_completed',
		'activation_session_created',
		'login_rejected',
		'login_succeeded',
		'logout_completed'
	))
);
--> statement-breakpoint
CREATE INDEX `auth_events_principal_time_idx` ON `auth_events` (`principal_id`,`occurred_at`);
--> statement-breakpoint
CREATE TRIGGER `auth_credentials_single_owner`
BEFORE INSERT ON `auth_credentials`
WHEN NEW.`principal_id` != 'principal-local-owner'
BEGIN
	SELECT RAISE(ABORT, 'auth_credentials_owner_invalid');
END;
--> statement-breakpoint
CREATE TRIGGER `auth_credentials_identity_immutable`
BEFORE UPDATE OF `principal_id`, `login`, `created_at` ON `auth_credentials`
BEGIN
	SELECT RAISE(ABORT, 'auth_credentials_identity_immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `auth_credentials_prevent_delete`
BEFORE DELETE ON `auth_credentials`
BEGIN
	SELECT RAISE(ABORT, 'auth_credentials_delete_requires_recovery_workflow');
END;
--> statement-breakpoint
CREATE TRIGGER `auth_events_prevent_update`
BEFORE UPDATE ON `auth_events`
BEGIN
	SELECT RAISE(ABORT, 'auth_events_are_append_only');
END;
--> statement-breakpoint
CREATE TRIGGER `auth_events_prevent_delete`
BEFORE DELETE ON `auth_events`
BEGIN
	SELECT RAISE(ABORT, 'auth_events_are_append_only');
END;

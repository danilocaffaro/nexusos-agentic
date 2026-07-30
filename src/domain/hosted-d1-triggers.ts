const BREAKPOINT = "--> statement-breakpoint";
const TRIGGER_NAME_PATTERN = /^[a-z][a-z0-9_]{0,127}$/u;

export type HostedD1Trigger = Readonly<{
  name: string;
  createSql: string;
}>;

export function finalHostedD1Triggers(
  migrations: readonly string[],
): readonly HostedD1Trigger[] {
  if (!Array.isArray(migrations) || migrations.length === 0) {
    throw new TypeError("Hosted D1 migrations are required.");
  }
  const active = new Map<string, string>();

  for (const migration of migrations) {
    if (typeof migration !== "string" || migration.length === 0) {
      throw new TypeError("Hosted D1 migrations must be non-empty SQL.");
    }
    for (const rawStatement of migration.split(BREAKPOINT)) {
      const statement = stripLeadingComments(rawStatement);
      if (!statement) {
        throw new TypeError("Hosted D1 migrations contain an empty chunk.");
      }
      const createName = triggerName(statement, "CREATE");
      if (createName) {
        if (active.has(createName)) {
          throw new TypeError(`Duplicate hosted D1 trigger: ${createName}`);
        }
        active.set(
          createName,
          statement.replace(
            /^CREATE\s+TRIGGER\b/iu,
            "CREATE TRIGGER IF NOT EXISTS",
          ),
        );
        continue;
      }
      const dropName = triggerName(statement, "DROP");
      if (dropName) {
        if (!active.delete(dropName)) {
          throw new TypeError(`Unknown hosted D1 trigger drop: ${dropName}`);
        }
      }
    }
  }

  return Object.freeze(
    Array.from(active, ([name, createSql]) =>
      Object.freeze({ name, createSql }),
    ).sort((left, right) => left.name.localeCompare(right.name)),
  );
}

function triggerName(
  statement: string,
  operation: "CREATE" | "DROP",
): string | null {
  const match = statement.match(
    /^(CREATE|DROP)\s+TRIGGER\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:`([^`]+)`|"([^"]+)"|\[([^\]]+)\]|([a-z_][a-z0-9_]*))/iu,
  );
  if (!match || match[1]?.toUpperCase() !== operation) return null;
  const name = match[2] ?? match[3] ?? match[4] ?? match[5];
  if (!name || !TRIGGER_NAME_PATTERN.test(name)) {
    throw new TypeError("Hosted D1 trigger name is invalid.");
  }
  return name;
}

function stripLeadingComments(value: string): string {
  let statement = value.trim();
  while (statement.startsWith("--") || statement.startsWith("/*")) {
    if (statement.startsWith("--")) {
      const newline = statement.search(/[\r\n]/u);
      if (newline === -1) return "";
      statement = statement.slice(newline + 1).trimStart();
      continue;
    }
    const end = statement.indexOf("*/", 2);
    if (end === -1) {
      throw new TypeError("Hosted D1 migration contains an open comment.");
    }
    statement = statement.slice(end + 2).trimStart();
  }
  return statement;
}

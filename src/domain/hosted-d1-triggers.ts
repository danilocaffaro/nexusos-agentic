const BREAKPOINT = "--> statement-breakpoint";
const TRIGGER_NAME_PATTERN = /^[a-z][a-z0-9_]{0,127}$/u;

export type HostedD1Trigger = Readonly<{
  name: string;
  createSql: string;
}>;

export type ObservedHostedD1Trigger = Readonly<{
  name: string;
  sql: string | null;
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
    ).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    ),
  );
}

export function assertHostedD1TriggerAttestation(
  expected: readonly HostedD1Trigger[],
  observed: readonly ObservedHostedD1Trigger[],
): void {
  if (
    !Array.isArray(expected) ||
    !Array.isArray(observed) ||
    expected.length === 0 ||
    observed.length !== expected.length
  ) {
    throw new TypeError("Hosted D1 trigger attestation failed.");
  }
  for (let index = 0; index < expected.length; index += 1) {
    const expectedTrigger = expected[index];
    const observedTrigger = observed[index];
    if (
      !expectedTrigger ||
      !observedTrigger ||
      observedTrigger.name !== expectedTrigger.name ||
      canonicalHostedD1TriggerSql(observedTrigger.sql) !==
        canonicalHostedD1TriggerSql(expectedTrigger.createSql)
    ) {
      throw new TypeError("Hosted D1 trigger attestation failed.");
    }
  }
}

export function canonicalHostedD1TriggerSql(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("Hosted D1 trigger SQL is required.");
  }
  const statement = stripLeadingComments(value)
    .replace(
      /^CREATE\s+TRIGGER\s+IF\s+NOT\s+EXISTS\b/iu,
      "CREATE TRIGGER",
    )
    .trim();
  const canonical = compactSql(statement).replace(/;$/u, "");
  if (!triggerName(canonical, "CREATE")) {
    throw new TypeError("Hosted D1 trigger SQL is invalid.");
  }
  return canonical;
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

function compactSql(value: string): string {
  let output = "";
  let pendingSpace = false;
  let quote: "'" | '"' | "`" | "]" | null = null;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    const next = value[index + 1];
    if (quote) {
      output += character;
      if (quote === "]") {
        if (character === "]") quote = null;
        continue;
      }
      if (character !== quote) continue;
      if (next === quote) {
        output += next;
        index += 1;
      } else {
        quote = null;
      }
      continue;
    }
    if (character === "-" && next === "-") {
      index += 2;
      while (
        index < value.length &&
        !/[\r\n]/u.test(value[index]!)
      ) {
        index += 1;
      }
      pendingSpace = output.length > 0;
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      while (
        index < value.length - 1 &&
        !(value[index] === "*" && value[index + 1] === "/")
      ) {
        index += 1;
      }
      if (index >= value.length - 1) {
        throw new TypeError("Hosted D1 trigger SQL has an open comment.");
      }
      index += 1;
      pendingSpace = output.length > 0;
      continue;
    }
    if (isSqliteTokenizerWhitespace(character)) {
      pendingSpace = output.length > 0;
      continue;
    }
    if (pendingSpace) {
      output += " ";
      pendingSpace = false;
    }
    output += character;
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
    } else if (character === "[") {
      quote = "]";
    }
  }
  if (quote) {
    throw new TypeError("Hosted D1 trigger SQL has an open quote.");
  }
  return output.trim();
}

function isSqliteTokenizerWhitespace(character: string): boolean {
  return (
    character === " " ||
    character === "\t" ||
    character === "\n" ||
    character === "\f" ||
    character === "\r"
  );
}

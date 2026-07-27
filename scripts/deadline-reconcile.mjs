const baseUrl = process.env.NEXUS_LOCAL_OPERATOR_URL ?? "http://127.0.0.1:3001";
let endpoint;
try {
  endpoint = new URL("/api/system/deadlines/reconcile", baseUrl);
} catch {
  console.error("NEXUS_LOCAL_OPERATOR_URL must be a valid local HTTP URL.");
  process.exitCode = 2;
  process.exit();
}
if (
  endpoint.protocol !== "http:" ||
  !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
  endpoint.username ||
  endpoint.password
) {
  console.error("Deadline reconciliation is restricted to a loopback URL.");
  process.exitCode = 2;
  process.exit();
}

try {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-nexus-local-operator": "deadline-reconcile-v1",
    },
    body: "{}",
    redirect: "error",
  });
  const body = await response.text();
  if (!response.ok) {
    console.error(body || `Deadline reconciliation failed (${response.status}).`);
    process.exitCode = 1;
  } else {
    console.log(body);
  }
} catch (error) {
  console.error(
    error instanceof Error
      ? `Deadline reconciliation failed: ${error.message}`
      : "Deadline reconciliation failed.",
  );
  process.exitCode = 1;
}

#!/usr/bin/env node

import {
  GitHubInstallationDiscoveryError,
} from "../../src/contracts/github-installation-discovery.ts";
import {
  createGitHubInstallationDiscoveryTransport,
} from "../../src/adapters/github/github-installation-discovery.ts";
import {
  createGitHubInstallationSnapshotSource,
} from "../../src/domain/github/github-installation-snapshot.ts";

const REQUIRED_ENVIRONMENT = [
  "GITHUB_APP_JWT",
  "GITHUB_APP_JWT_EXPIRES_AT",
  "GITHUB_INSTALLATION_ID",
  "GITHUB_INSTALLATION_TOKEN",
  "GITHUB_INSTALLATION_TOKEN_EXPIRES_AT",
];

const missing = REQUIRED_ENVIRONMENT.filter((name) => !process.env[name]);
if (missing.length > 0) {
  write({
    status: "SKIP",
    reason: "credentials_missing",
    missing: missing.sort(),
  });
  process.exitCode = 2;
}
else {
  await run();
}

async function run() {
  const installationId = process.env.GITHUB_INSTALLATION_ID;
  const appJwtExpiresAt = parseExpiry(
    process.env.GITHUB_APP_JWT_EXPIRES_AT,
  );
  const installationTokenExpiresAt = parseExpiry(
    process.env.GITHUB_INSTALLATION_TOKEN_EXPIRES_AT,
  );
  let appJwt = process.env.GITHUB_APP_JWT;
  let installationToken = process.env.GITHUB_INSTALLATION_TOKEN;
  for (const name of REQUIRED_ENVIRONMENT) delete process.env[name];

  if (
    !installationId ||
    !appJwt ||
    !installationToken ||
    appJwtExpiresAt === undefined ||
    installationTokenExpiresAt === undefined
  ) {
    appJwt = undefined;
    installationToken = undefined;
    write({ status: "FAIL", code: "invalid_live_input" });
    process.exitCode = 1;
    return;
  }

  const observations = [];
  const repositoryIds = [];
  try {
    const transport = createGitHubInstallationDiscoveryTransport({
      installationId,
      appJwt: {
        kind: "app-jwt",
        installationId,
        expiresAtEpochMs: appJwtExpiresAt,
        reveal: () => appJwt,
        release: () => {
          appJwt = undefined;
        },
      },
      installationToken: {
        kind: "installation-token",
        installationId,
        expiresAtEpochMs: installationTokenExpiresAt,
        reveal: () => installationToken,
        release: () => {
          installationToken = undefined;
        },
      },
    }, {
      observe: (observation) => observations.push(observation),
    });
    const source = await createGitHubInstallationSnapshotSource({
      async readPage(pageInput) {
        const page = await transport.readPage(pageInput);
        if (page && typeof page === "object") {
          const repositories = page.repositories;
          if (Array.isArray(repositories)) {
            for (const repository of repositories) {
              const repositoryId = repository &&
                typeof repository === "object" &&
                Object.getOwnPropertyDescriptor(repository, "repositoryId");
              if (
                repositoryId?.enumerable === true &&
                "value" in repositoryId &&
                typeof repositoryId.value === "string"
              ) {
                repositoryIds.push(repositoryId.value);
              }
            }
          }
        }
        return page;
      },
    });
    if (!source) {
      throw new GitHubInstallationDiscoveryError("malformed_response");
    }
    if (repositoryIds.length === 0) {
      write({
        status: "FAIL",
        code: "no_repository_in_installation",
        installationId,
        repositoryCount: 0,
      });
      process.exitCode = 1;
      return;
    }
    const sampleScope = await source.readScope({
      installationId,
      repositoryId: repositoryIds[0],
    });
    if (!sampleScope) {
      throw new GitHubInstallationDiscoveryError("malformed_response");
    }

    write({
      status: "PASS",
      installationId,
      repositoryCount: repositoryIds.length,
      sampleRepositoryId: sampleScope.repository.repositoryId,
      repositorySelection: sampleScope.repositorySelection,
      requests: observations.map((observation) => ({
        requestKind: observation.requestKind,
        status: observation.status,
        rateLimit: observation.rateLimit,
      })),
    });
    process.exitCode = 0;
  }
  catch (error) {
    appJwt = undefined;
    installationToken = undefined;
    write({
      status: "FAIL",
      code: error instanceof GitHubInstallationDiscoveryError
        ? error.code
        : "live_acceptance_failed",
    });
    process.exitCode = 1;
  }
}

function parseExpiry(value) {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

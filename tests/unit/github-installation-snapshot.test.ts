import assert from "node:assert/strict";
import test from "node:test";
import {
  GITHUB_INSTALLATION_SNAPSHOT_MAX_CURSOR_LENGTH,
  GITHUB_INSTALLATION_SNAPSHOT_MAX_PAGE_CALLS,
  GITHUB_INSTALLATION_SNAPSHOT_PAGE_SPEC_VERSION,
} from "../../src/contracts/github-installation-snapshot";
import type {
  GitHubInstallationSnapshotPageInput,
  GitHubInstallationSnapshotTransport,
} from "../../src/contracts/github-installation-snapshot";
import {
  GITHUB_AUTHORIZATION_SPEC_VERSION,
} from "../../src/contracts/github-authorization";
import {
  createGitHubInstallationSnapshotSource,
} from "../../src/domain/github/github-installation-snapshot";

const installation = {
  installationId: "12345678",
  installationState: "active",
  repositorySelection: "selected",
  permissions: {
    contents: "write",
    metadata: "read",
    issues: "write",
    checks: "read",
  },
} as const;

const repositories = [
  {
    repositoryId: "987654321",
    owner: "Nexus-OS",
    name: "Control_Plane.GIT",
  },
  {
    repositoryId: "987654322",
    owner: "nexus-os",
    name: "runtime",
  },
] as const;

type PageOptions = Readonly<{
  pageIndex: number;
  cursor: string | null;
  nextCursor: string | null;
  totalRepositories: number;
  repositories: readonly unknown[];
  installation?: unknown;
}>;

function page(options: PageOptions): Record<string, unknown> {
  return {
    specVersion: GITHUB_INSTALLATION_SNAPSHOT_PAGE_SPEC_VERSION,
    pageIndex: options.pageIndex,
    cursor: options.cursor,
    nextCursor: options.nextCursor,
    totalRepositories: options.totalRepositories,
    installation: options.installation ?? installation,
    repositories: options.repositories,
  };
}

test("snapshot page vocabulary and resource bounds are versioned", () => {
  assert.equal(
    GITHUB_INSTALLATION_SNAPSHOT_PAGE_SPEC_VERSION,
    "nexusos.github-installation-snapshot-page.v1",
  );
  assert.equal(GITHUB_INSTALLATION_SNAPSHOT_MAX_PAGE_CALLS, 500);
  assert.equal(GITHUB_INSTALLATION_SNAPSHOT_MAX_CURSOR_LENGTH, 1024);
});

test("multi-page aggregation feeds B3 and reads exact normalized scopes", async () => {
  const requests: GitHubInstallationSnapshotPageInput[] = [];
  const documents = [
    page({
      pageIndex: 0,
      cursor: null,
      nextCursor: "opaque/+=?% cursor",
      totalRepositories: 2,
      repositories: [repositories[0]],
    }),
    page({
      pageIndex: 1,
      cursor: "opaque/+=?% cursor",
      nextCursor: null,
      totalRepositories: 2,
      repositories: [repositories[1]],
    }),
  ];
  const transport = {
    readPage: async (request: GitHubInstallationSnapshotPageInput) => {
      requests.push(request);
      assert.equal(Object.isFrozen(request), true);
      assert.deepEqual(Reflect.ownKeys(request), ["pageIndex", "cursor"]);
      return documents[request.pageIndex];
    },
  } satisfies GitHubInstallationSnapshotTransport;

  const source = await createGitHubInstallationSnapshotSource(transport);
  assert.ok(source);
  assert.deepEqual(requests, [
    { pageIndex: 0, cursor: null },
    { pageIndex: 1, cursor: "opaque/+=?% cursor" },
  ]);
  assert.deepEqual(
    await source.readScope({
      installationId: "12345678",
      repositoryId: "987654321",
    }),
    {
      specVersion: GITHUB_AUTHORIZATION_SPEC_VERSION,
      installationState: "active",
      repositorySelection: "selected",
      repository: {
        installationId: "12345678",
        repositoryId: "987654321",
        owner: "nexus-os",
        name: "control_plane.git",
      },
      permissions: [
        { name: "metadata", access: "read" },
        { name: "issues", access: "write" },
        { name: "checks", access: "read" },
        { name: "contents", access: "write" },
      ],
    },
  );
  assert.equal(
    (await source.readScope({
      installationId: "12345678",
      repositoryId: "987654322",
    }))?.repository.name,
    "runtime",
  );
  assert.equal(
    await source.readScope({
      installationId: "12345678",
      repositoryId: "987654323",
    }),
    undefined,
  );
});

test("all selection remains limited to repositories in the loaded snapshot", async () => {
  const source = await createGitHubInstallationSnapshotSource({
    readPage: async () =>
      page({
        pageIndex: 0,
        cursor: null,
        nextCursor: null,
        totalRepositories: 1,
        installation: {
          ...installation,
          repositorySelection: "all",
        },
        repositories: [repositories[0]],
      }),
  });
  assert.ok(source);
  assert.equal(
    (await source.readScope({
      installationId: "12345678",
      repositoryId: "987654321",
    }))?.repositorySelection,
    "all",
  );
  assert.equal(
    await source.readScope({
      installationId: "12345678",
      repositoryId: "987654322",
    }),
    undefined,
  );
});

test("snapshot rejects totals above 500 and page overflow", async () => {
  let calls = 0;
  assert.equal(
    await createGitHubInstallationSnapshotSource({
      readPage: async () => {
        calls += 1;
        return page({
          pageIndex: 0,
          cursor: null,
          nextCursor: null,
          totalRepositories: 501,
          repositories: [],
        });
      },
    }),
    undefined,
  );
  assert.equal(calls, 1);

  assert.equal(
    await createGitHubInstallationSnapshotSource({
      readPage: async () =>
        page({
          pageIndex: 0,
          cursor: null,
          nextCursor: null,
          totalRepositories: 500,
          repositories: Array.from({ length: 501 }, (_, index) => ({
            repositoryId: String(index + 1),
            owner: "nexus-os",
            name: `repo-${index + 1}`,
          })),
        }),
    }),
    undefined,
  );
});

test("snapshot rejects inconsistent totals, installation facts and termination", async () => {
  for (const secondPage of [
    page({
      pageIndex: 1,
      cursor: "next",
      nextCursor: null,
      totalRepositories: 3,
      repositories: [repositories[1]],
    }),
    page({
      pageIndex: 1,
      cursor: "next",
      nextCursor: null,
      totalRepositories: 2,
      installation: { ...installation, installationState: "suspended" },
      repositories: [repositories[1]],
    }),
    page({
      pageIndex: 1,
      cursor: "next",
      nextCursor: null,
      totalRepositories: 2,
      installation: { ...installation, repositorySelection: "all" },
      repositories: [repositories[1]],
    }),
    page({
      pageIndex: 1,
      cursor: "next",
      nextCursor: null,
      totalRepositories: 2,
      installation: { ...installation, installationId: "12345679" },
      repositories: [repositories[1]],
    }),
    page({
      pageIndex: 1,
      cursor: "next",
      nextCursor: null,
      totalRepositories: 2,
      installation: {
        ...installation,
        permissions: { ...installation.permissions, issues: "read" },
      },
      repositories: [repositories[1]],
    }),
  ]) {
    const source = await createGitHubInstallationSnapshotSource({
      readPage: async ({ pageIndex }) =>
        pageIndex === 0
          ? page({
            pageIndex: 0,
            cursor: null,
            nextCursor: "next",
            totalRepositories: 2,
            repositories: [repositories[0]],
          })
          : secondPage,
    });
    assert.equal(source, undefined);
  }

  assert.equal(
    await createGitHubInstallationSnapshotSource({
      readPage: async () =>
        page({
          pageIndex: 0,
          cursor: null,
          nextCursor: null,
          totalRepositories: 2,
          repositories: [repositories[0]],
        }),
    }),
    undefined,
  );
  assert.equal(
    await createGitHubInstallationSnapshotSource({
      readPage: async () =>
        page({
          pageIndex: 0,
          cursor: null,
          nextCursor: "next",
          totalRepositories: 1,
          repositories: [repositories[0]],
        }),
    }),
    undefined,
  );
});

test("overlap, duplicate identities and duplicate cursors fail closed", async () => {
  for (const secondRepository of [
    repositories[0],
    { ...repositories[1], repositoryId: repositories[0].repositoryId },
    {
      repositoryId: repositories[1].repositoryId,
      owner: "nexus-os",
      name: "Control_Plane.GIT",
    },
  ]) {
    assert.equal(
      await createGitHubInstallationSnapshotSource({
        readPage: async ({ pageIndex }) =>
          pageIndex === 0
            ? page({
              pageIndex: 0,
              cursor: null,
              nextCursor: "next",
              totalRepositories: 2,
              repositories: [repositories[0]],
            })
            : page({
              pageIndex: 1,
              cursor: "next",
              nextCursor: null,
              totalRepositories: 2,
              repositories: [secondRepository],
            }),
      }),
      undefined,
    );
  }

  let calls = 0;
  assert.equal(
    await createGitHubInstallationSnapshotSource({
      readPage: async ({ pageIndex, cursor }) => {
        calls += 1;
        return page({
          pageIndex,
          cursor,
          nextCursor: "same",
          totalRepositories: 3,
          repositories: [{
            repositoryId: String(pageIndex + 1),
            owner: "nexus-os",
            name: `repo-${pageIndex + 1}`,
          }],
        });
      },
    }),
    undefined,
  );
  assert.equal(calls, 2);
});

test("wire pages are copied before later transport mutation", async () => {
  const first = page({
    pageIndex: 0,
    cursor: null,
    nextCursor: "next",
    totalRepositories: 2,
    repositories: [{ ...repositories[0] }],
    installation: {
      ...installation,
      permissions: { ...installation.permissions },
    },
  });
  const firstInstallation = first.installation as {
    installationId: string;
    permissions: { contents: string };
  };
  const firstRepository = (first.repositories as Array<{ owner: string }>)[0]!;
  const originalReadPage = async (
    request: GitHubInstallationSnapshotPageInput,
  ): Promise<unknown> => {
    if (request.pageIndex === 0) {
      (transport as { readPage: GitHubInstallationSnapshotTransport["readPage"] })
        .readPage = async () => {
          throw new Error("replacement must not be observed");
        };
      return first;
    }
    firstInstallation.installationId = "12345679";
    firstInstallation.permissions.contents = "read";
    firstRepository.owner = "attacker";
    return page({
      pageIndex: 1,
      cursor: "next",
      nextCursor: null,
      totalRepositories: 2,
      repositories: [{ ...repositories[1] }],
    });
  };
  const transport = { readPage: originalReadPage };

  const source = await createGitHubInstallationSnapshotSource(transport);
  assert.ok(source);
  assert.equal(
    (await source.readScope({
      installationId: "12345678",
      repositoryId: "987654321",
    }))?.repository.owner,
    "nexus-os",
  );
  assert.deepEqual(
    (await source.readScope({
      installationId: "12345678",
      repositoryId: "987654322",
    }))?.permissions.at(-1),
    { name: "contents", access: "write" },
  );
});

test("suspended and empty snapshots are represented without widening authority", async () => {
  const suspended = await createGitHubInstallationSnapshotSource({
    readPage: async () =>
      page({
        pageIndex: 0,
        cursor: null,
        nextCursor: null,
        totalRepositories: 1,
        installation: {
          ...installation,
          installationState: "suspended",
        },
        repositories: [repositories[0]],
      }),
  });
  assert.ok(suspended);
  assert.equal(
    (await suspended.readScope({
      installationId: "12345678",
      repositoryId: "987654321",
    }))?.installationState,
    "suspended",
  );

  const empty = await createGitHubInstallationSnapshotSource({
    readPage: async () =>
      page({
        pageIndex: 0,
        cursor: null,
        nextCursor: null,
        totalRepositories: 0,
        repositories: [],
      }),
  });
  assert.ok(empty);
  assert.equal(
    await empty.readScope({
      installationId: "12345678",
      repositoryId: "987654321",
    }),
    undefined,
  );
});

test("a unique opaque cursor may cross an empty intermediate page", async () => {
  const source = await createGitHubInstallationSnapshotSource({
    readPage: async ({ pageIndex, cursor }) =>
      pageIndex === 0
        ? page({
          pageIndex,
          cursor,
          nextCursor: "empty-page",
          totalRepositories: 1,
          repositories: [],
        })
        : page({
          pageIndex,
          cursor,
          nextCursor: null,
          totalRepositories: 1,
          repositories: [repositories[0]],
        }),
  });
  assert.ok(source);
  assert.equal(
    (await source.readScope({
      installationId: "12345678",
      repositoryId: "987654321",
    }))?.repository.owner,
    "nexus-os",
  );
});

test("valid 500-page snapshots succeed and nonterminal snapshots stop at 500 calls", async () => {
  async function load(nonterminal: boolean) {
    let calls = 0;
    const source = await createGitHubInstallationSnapshotSource({
      readPage: async ({ pageIndex, cursor }) => {
        calls += 1;
        return page({
          pageIndex,
          cursor,
          nextCursor: pageIndex === 499 && !nonterminal
            ? null
            : `cursor-${pageIndex + 1}`,
          totalRepositories: 500,
          repositories: [{
            repositoryId: String(pageIndex + 1),
            owner: "nexus-os",
            name: `repo-${pageIndex + 1}`,
          }],
        });
      },
    });
    return { source, calls };
  }

  const complete = await load(false);
  assert.equal(complete.calls, GITHUB_INSTALLATION_SNAPSHOT_MAX_PAGE_CALLS);
  assert.ok(complete.source);
  assert.equal(
    (await complete.source.readScope({
      installationId: "12345678",
      repositoryId: "500",
    }))?.repository.name,
    "repo-500",
  );

  const nonterminal = await load(true);
  assert.equal(nonterminal.calls, GITHUB_INSTALLATION_SNAPSHOT_MAX_PAGE_CALLS);
  assert.equal(nonterminal.source, undefined);
});

test("page index, cursor echo and opaque cursor bounds are enforced", async () => {
  for (const document of [
    page({
      pageIndex: 1,
      cursor: null,
      nextCursor: null,
      totalRepositories: 0,
      repositories: [],
    }),
    page({
      pageIndex: 0,
      cursor: "unexpected",
      nextCursor: null,
      totalRepositories: 0,
      repositories: [],
    }),
    page({
      pageIndex: 0,
      cursor: null,
      nextCursor: "",
      totalRepositories: 1,
      repositories: [repositories[0]],
    }),
    page({
      pageIndex: 0,
      cursor: null,
      nextCursor: "x".repeat(
        GITHUB_INSTALLATION_SNAPSHOT_MAX_CURSOR_LENGTH + 1,
      ),
      totalRepositories: 2,
      repositories: [repositories[0]],
    }),
  ]) {
    assert.equal(
      await createGitHubInstallationSnapshotSource({
        readPage: async () => document,
      }),
      undefined,
    );
  }

  const maximumCursor = "x".repeat(
    GITHUB_INSTALLATION_SNAPSHOT_MAX_CURSOR_LENGTH,
  );
  const source = await createGitHubInstallationSnapshotSource({
    readPage: async ({ pageIndex }) =>
      pageIndex === 0
        ? page({
          pageIndex: 0,
          cursor: null,
          nextCursor: maximumCursor,
          totalRepositories: 2,
          repositories: [repositories[0]],
        })
        : page({
          pageIndex: 1,
          cursor: maximumCursor,
          nextCursor: null,
          totalRepositories: 2,
          repositories: [repositories[1]],
        }),
  });
  assert.ok(source);
});

test("malformed and hostile wire documents fail closed without invoking accessors", async () => {
  let accessorRead = false;
  const accessorPage = page({
    pageIndex: 0,
    cursor: null,
    nextCursor: null,
    totalRepositories: 0,
    repositories: [],
  });
  Object.defineProperty(accessorPage, "specVersion", {
    enumerable: true,
    get: () => {
      accessorRead = true;
      return GITHUB_INSTALLATION_SNAPSHOT_PAGE_SPEC_VERSION;
    },
  });

  const accessorRepository = { ...repositories[0] };
  Object.defineProperty(accessorRepository, "owner", {
    enumerable: true,
    get: () => {
      accessorRead = true;
      return "nexus-os";
    },
  });

  const sparse = Array(1);
  const symbolPage = {
    ...page({
      pageIndex: 0,
      cursor: null,
      nextCursor: null,
      totalRepositories: 0,
      repositories: [],
    }),
    [Symbol("hidden")]: true,
  };
  class ExoticRepositories extends Array<unknown> {}
  const hostile = new Proxy({}, {
    ownKeys: () => {
      throw new Error("hostile");
    },
  });
  const pageWithProto = withOwnProto(page({
    pageIndex: 0,
    cursor: null,
    nextCursor: null,
    totalRepositories: 0,
    repositories: [],
  }));
  const installationWithProto = withOwnProto({ ...installation });
  const permissionsWithProto = withOwnProto({ ...installation.permissions });
  const repositoryWithProto = withOwnProto({ ...repositories[0] });

  for (const document of [
    accessorPage,
    page({
      pageIndex: 0,
      cursor: null,
      nextCursor: null,
      totalRepositories: 1,
      repositories: [accessorRepository],
    }),
    page({
      pageIndex: 0,
      cursor: null,
      nextCursor: null,
      totalRepositories: 1,
      repositories: sparse,
    }),
    page({
      pageIndex: 0,
      cursor: null,
      nextCursor: null,
      totalRepositories: 0,
      repositories: new ExoticRepositories(),
    }),
    symbolPage,
    hostile,
    pageWithProto,
    page({
      pageIndex: 0,
      cursor: null,
      nextCursor: null,
      totalRepositories: 0,
      installation: installationWithProto,
      repositories: [],
    }),
    page({
      pageIndex: 0,
      cursor: null,
      nextCursor: null,
      totalRepositories: 0,
      installation: {
        ...installation,
        permissions: permissionsWithProto,
      },
      repositories: [],
    }),
    page({
      pageIndex: 0,
      cursor: null,
      nextCursor: null,
      totalRepositories: 1,
      repositories: [repositoryWithProto],
    }),
    { ...page({
      pageIndex: 0,
      cursor: null,
      nextCursor: null,
      totalRepositories: 0,
      repositories: [],
    }), future: true },
    { ...page({
      pageIndex: 0,
      cursor: null,
      nextCursor: null,
      totalRepositories: 0,
      repositories: [],
    }), specVersion: "future" },
    page({
      pageIndex: 0,
      cursor: null,
      nextCursor: null,
      totalRepositories: 0,
      installation: {
        ...installation,
        permissions: {
          ...installation.permissions,
          administration: "write",
        },
      },
      repositories: [],
    }),
    page({
      pageIndex: 0,
      cursor: null,
      nextCursor: null,
      totalRepositories: 0,
      installation: {
        ...installation,
        permissions: { metadata: "write" },
      },
      repositories: [],
    }),
    page({
      pageIndex: 0,
      cursor: null,
      nextCursor: null,
      totalRepositories: 0,
      installation: {
        ...installation,
        permissions: {},
      },
      repositories: [],
    }),
    page({
      pageIndex: 0,
      cursor: null,
      nextCursor: null,
      totalRepositories: 1,
      repositories: [{ ...repositories[0], repositoryId: "0" }],
    }),
  ]) {
    assert.equal(
      await createGitHubInstallationSnapshotSource({
        readPage: async () => document,
      }),
      undefined,
    );
  }
  assert.equal(accessorRead, false);
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});

test("hostile transports and failures return undefined without an extra call", async () => {
  let accessorRead = false;
  const accessorTransport = {};
  Object.defineProperty(accessorTransport, "readPage", {
    enumerable: true,
    get: () => {
      accessorRead = true;
      return async () => undefined;
    },
  });
  assert.equal(
    await createGitHubInstallationSnapshotSource(accessorTransport as never),
    undefined,
  );
  assert.equal(accessorRead, false);
  assert.equal(
    await createGitHubInstallationSnapshotSource({
      readPage: async () => undefined,
      extra: true,
    } as never),
    undefined,
  );

  let calls = 0;
  assert.equal(
    await createGitHubInstallationSnapshotSource({
      readPage: async () => {
        calls += 1;
        throw new Error("unavailable");
      },
    }),
    undefined,
  );
  assert.equal(calls, 1);
  assert.equal(
    await createGitHubInstallationSnapshotSource({
      readPage: "not-a-function",
    } as never),
    undefined,
  );
  assert.equal(
    await createGitHubInstallationSnapshotSource(new Proxy({}, {
      getPrototypeOf: () => {
        throw new Error("hostile");
      },
    }) as never),
    undefined,
  );
});

function withOwnProto<T extends object>(value: T): T {
  Object.defineProperty(value, "__proto__", {
    configurable: true,
    enumerable: true,
    value: { polluted: true },
    writable: true,
  });
  return value;
}

# NexusOS

NexusOS é um Organization OS local-first para projetos e times híbridos de
humanos e agentes. O primeiro uso começa vazio, conduz o setup e persiste o
trabalho em D1/SQLite no host do usuário. O perfil Remote Access v1.1 acrescenta
uma interface HTTPS autenticada sem publicar o banco, os CLIs ou uma porta do
Mac diretamente na internet.

## O que funciona

- onboarding de workspace, owner, primeiro projeto e primeiro time;
- CRUD de projetos, times, agentes, objetivos e work items;
- agentes com role, modelo, autonomia, escopo de memória e conexão opcional;
- DMs, salas, membros, mensagens, pins, handoffs e presença efêmera;
- troca autenticada de até três arquivos por mensagem, 25 MB por arquivo, com
  armazenamento local privado e download forçado;
- inbox governada, ActionIntents, aprovações, evidências e Decision Packages;
- outputs Markdown versionados, reviews, supersession e erasure governada;
- runners locais com matrícula de uso único, identidade Ed25519, heartbeat,
  admission policy e inventário de engines;
- operações owner-only que vinculam projeto, work item, agente, modelo, runner
  e Claude Code/Codex CLI;
- publicação do output confirmado como artefato e registro no Decision Ledger;
- ledger encadeado e append-only no schema da aplicação.

Não há dados de exemplo no primeiro uso normal. Fixtures só são habilitadas em
processos de teste explicitamente isolados.

## Dois perfis operacionais

- **Core Local:** loopback, owner local e nenhuma dependência externa.
- **Remote Access:** login first-party, sessão opaca revogável, proteção contra
  CSRF, Oracle/Caddy como gateway e túnel SSH iniciado pelo Mac.

GitHub é o canal oficial de distribuição. Oracle, Cloudflare e um domínio são
opções de implantação remota, não autoridades de runtime nem dependências do
Core Local. Veja [Remote Access](docs/REMOTE-ACCESS.md).

## Limites honestos

- macOS e Linux são suportados; Windows não é suportado no v1;
- Remote Access v1.1 é single-owner; RBAC web multiusuário, recuperação de
  senha e MFA first-party ainda não fazem parte desta versão;
- arquivos recebidos são validados, limitados e servidos como download, mas
  recebem o estado honesto `not_scanned`: o v1.1 não inclui antivírus;
- execução LLM no v1 usa Claude Code CLI ou Codex CLI já instalado e
  autenticado no host do runner;
- OAuth direto dentro do NexusOS, áudio/vídeo, sandbox atestado, streaming,
  execução com tools/MCPs e mutação autônoma do workspace não fazem parte do
  v1.0;
- Jira, Slack, GitHub, Cloudflare, serviços pagos e contas de provedores não
  são necessários para iniciar e usar o control plane local. O gateway remoto
  pode usar Caddy direto ou Cloudflare Tunnel;
- uma credencial do provider nunca é copiada para o NexusOS. O CLI continua
  sendo o proprietário da própria sessão.

## Requisitos

- Node.js 22.19.0 ou compatível com `>=22.13.0`;
- npm e Git;
- macOS ou Linux;
- para operações com LLM, um CLI suportado instalado e autenticado
  separadamente.

## Instalar e iniciar

```bash
git clone https://github.com/danilocaffaro/nexusos-agentic.git
cd nexusos-agentic
npm ci
npm run local:ready
```

Abra a URL anunciada pelo launcher, normalmente
`http://127.0.0.1:3002`. O launcher aplica migrations antes de anunciar
readiness. O estado padrão permanece em `.wrangler/state`.

Para habilitar acesso HTTPS remoto depois da instalação local:

```bash
npm run remote:init -- --origin https://nexusos.example.com
npm run remote:service -- prepare
```

O primeiro comando mostra um token de ativação de uso único; o segundo mostra
a chave pública exclusiva do túnel. Provisione o gateway conforme
[Remote Access](docs/REMOTE-ACCESS.md) e instale os serviços persistentes.

No primeiro acesso, informe:

1. nome do workspace e do owner;
2. nome e objetivo do primeiro projeto;
3. nome e missão do primeiro time.

O setup é atômico e não reaparece depois de um restart bem-sucedido.

Para um estado ou port isolado:

```bash
npm run local:ready -- --state-dir /tmp/nexusos-state --port 3902
```

## Executar uma operação real

1. Em **Runners**, emita um token de matrícula.
2. Em outro terminal, use o comando mostrado na tela, informe a engine e o
   caminho absoluto do CLI e cole o token somente no prompt oculto.
3. Crie um agente em **Times & agentes**, um objetivo/work item em
   **Projetos** e abra **Operações**.
4. Selecione work item, agente e uma opção runner+engine elegível. O modelo vem
   do agente e não pode ser trocado no formulário da operação.
5. Crie a operação e execute o comando exato gerado com o `run_id`.
6. Use **Atualizar**. Somente um run concluído com output íntegro fica elegível
   para **Publicar output**.

Exemplo da forma do comando; a UI preenche server, engine e run e exige o path
absoluto antes de habilitar a cópia:

```bash
npm run local:engine -- \
  --engine claude_code_cli \
  --path "/caminho/absoluto/para/claude" \
  --server "http://127.0.0.1:3002" \
  --run "run_00000000000000000000000000000000"
```

O runner executa somente o run indicado. Não há polling ambiente, fallback de
provider ou publicação automática. Output vazio, truncado, apagado, malformado
ou proveniente de run falho é bloqueado.

## Instalar uma release verificável

Use os assets da
[GitHub Release](https://github.com/danilocaffaro/nexusos-agentic/releases):

- `nexusos-core-local-VERSION-source.tgz`;
- `nexusos-core-local-VERSION.manifest.json`;
- `SHA256SUMS`;
- SBOMs SPDX e CycloneDX.

Veja [INSTALL](docs/INSTALL.md) para checksum e attestation,
[BACKUP-RESTORE](docs/BACKUP-RESTORE.md) antes de upgrades e
[SECURITY](SECURITY.md) para o limite de confiança local.

## Desenvolvimento e validação

```bash
npm ci
npm test
npm run lint
npm run audit:prod
```

`npm test` cobre contratos, runner, migrations, release, integrações, build e
smoke. O acceptance local de restart/persistência é:

```bash
npm run test:usability
```

Licença: [Apache-2.0](LICENSE).

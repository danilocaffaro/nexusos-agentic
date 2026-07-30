# NexusOS Vision Prototype

Protótipo navegável do end-state do NexusOS: um Organization OS para times
híbridos de humanos e agentes.

## Jornadas representadas

- onboarding de organização, GitHub, provedores e execution pools;
- criação do primeiro projeto e composição do time híbrido;
- briefing diário, portfólio e operação ao vivo;
- decisões HITL vinculadas a intenção e evidências;
- agentes com papel, modelo, conexão, skills, memória e autonomia;
- automações duráveis com trigger, owner, budget e política de parada;
- acesso a LLMs por OAuth ou sessões autenticadas de Claude Code/Codex CLI.

## Desenvolvimento

```bash
npm install
npm run dev
npm test
```

`npm run dev` applies pending local D1 migrations idempotently before starting.
Use `npm run db:migrate:local` directly only when you need to migrate without
starting the development server.

## Versão local utilizável

Para iniciar a versão local com URL, estado e runner audience coerentes:

```bash
npm run local:ready
```

O launcher aplica as migrações, inicia em
`http://127.0.0.1:3002` e só anuncia readiness depois de validar health,
workspace persistente e `/api/runners`. `Ctrl+C` encerra o runtime com
shutdown seguro. O estado do usuário permanece em `.wrangler/state`; logs e
registro do Miniflare também ficam dentro do projeto, nunca em um diretório
global.

Para uma execução descartável ou isolada:

```bash
npm run local:ready -- --state-dir /tmp/nexusos-isolado --port 3902
```

O acceptance test usa seu próprio diretório temporário, reinicia o runtime e
prova persistência de projeto, time, agente, DM, mensagem, artifact versionado,
ActionIntent e ledger sem chamar LLM:

```bash
npm run test:usability
```

O projeto usa vinext e D1/SQLite local. Projetos, times, agentes, conexões,
objetivos, itens de trabalho, ActionIntents e ledger já percorrem rotas
persistentes. O backend de colaboração também já persiste DMs, salas, handoffs,
membros e mensagens imutáveis. A interface de mensagens já lista, cria e envia
nesses canais, preserva rascunhos por conversa e reconcilia o histórico por
sequência com retry e backoff. A API de lifecycle também administra membros,
archive/reopen e pins com autorização e versões observadas; a UI expõe esses
fluxos no contexto da conversa, preserva histórico e adapta o painel de detalhes
para telas menores. A Inbox também já é real: propostas governadas criam itens
pessoais para owners/admins, a leitura registra somente `seen`, expiração e
decisão fecham a pendência sem apagar histórico, e o deep-link nunca faz
fallback para outro intent. Team Rooms agora lista as conversas persistentes
reais e publica somente presença efêmera autodeclarada (`available`, `focus` ou
`dnd`) com TTL, fencing e takeover explícito entre abas. Localização só pode
apontar para uma sala ativa compartilhada; DM, handoff, prompt privado e
histórico de tempo online não entram no roster. Áudio e vídeo continuam como
capability opcional rotulada `roadmap`. As demais superfícies demonstrativas
são rotuladas como `visioning` ou `roadmap`.

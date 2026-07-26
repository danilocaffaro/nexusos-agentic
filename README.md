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
npm run db:migrate:local
npm run dev
npm test
```

O projeto usa vinext e D1/SQLite local. Projetos, times, agentes, conexões,
objetivos, itens de trabalho, ActionIntents e ledger já percorrem rotas
persistentes. O backend de colaboração também já persiste DMs, salas, handoffs,
membros e mensagens imutáveis; a conexão dessa API com a interface é o próximo
small batch. As superfícies ainda demonstrativas são rotuladas como `visioning`
ou `roadmap`.

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

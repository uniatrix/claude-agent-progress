# agent-progress

Mod para o Claude Code que mostra, acima do prompt, uma barra de progresso para cada agente e subagente que está rodando na sessão. Funciona no terminal e no app desktop.

```
Agentes  1 rodando · 2 concluídos                  detalhes  ocultar
● Conversa principal          ············   …   2m00s
  ✓ Mapa do emulador          ████████████ 100%    27s  Relatório entregue
  ● Estrutura do site         ▒▒▒▒▒▒▒▒▒▒░░ ~92%    42s  Montar relatório
```

## Instalar

Num terminal com o Claude Code aberto, digite:

```
/plugin install agent-progress --marketplace uniatrix/claude-agent-progress
```

Responda `y` para adicionar o marketplace e escolha o escopo de usuário. Depois de instalado, ele também carrega nas sessões do app desktop.

## Como o percentual é calculado

- **Barra contínua (real):** o agente mantém uma checklist e a barra mostra quantas etapas já terminaram. Todo subagente recebe a instrução de reportar as etapas pela ferramenta `progress` do mod.
- **Barra listrada, com `~` (estimativa):** o agente não fez checklist. A barra sobe conforme o número de ferramentas usadas e o tempo decorrido, comparados com a média dos agentes do mesmo tipo que já terminaram. Nunca passa de 95%. A média fica salva entre sessões, então a estimativa melhora com o uso.
- **Sem barra:** a conversa principal sem checklist mostra só o tempo e a ação atual.

## Comandos

- `/agentes` abre o painel com a checklist completa de cada agente e a base de cada número. Também reexibe a faixa se você a ocultou.

## Opcional: checklist na conversa principal

Nos modelos mais novos, o Claude Code não liga as ferramentas de checklist (TaskCreate e TaskUpdate) por padrão. Para que a conversa principal também tenha barra real, adicione ao `~/.claude/settings.json`:

```json
"env": { "CLAUDE_CODE_ENABLE_TODO_TOOLS": "1" }
```

Sem isso, a conversa principal usa a ferramenta `progress` do próprio mod.

## Requisitos

Claude Code com suporte a mods de hooks em TypeScript (versão 2.1.295 ou mais nova). A API ainda é early access e pode mudar entre versões.

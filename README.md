# agent-progress

Mod para o Claude Code que mostra, num painel ao lado do chat, o que cada agente, subagente e tarefa em background da sessão está fazendo, com barra de progresso quando há um número de verdade. Funciona no app desktop e no terminal.

```
2 agentes · 1 em background

● Mapa do emulador                 busca · 1m20s
  ███████████████░░░░░░░░░  62%
  etapa 4 de 6: Resumir os temas
  Lendo process_ci_deploy.md

● Renderizar o episódio          comando · 4m02s
  ██████████████████████░░  84%
  Rendered 13914/16638, time remaining: 6m

● Pesquisa de logs                agente · 45s
  Buscando "deploy"

Concluídos  limpar
✓ Estrutura do site · busca · 48s
```

O painel abre sozinho quando algum trabalho começa. Se você fechar, ele fica fechado na sessão e o chat mostra só uma linha ("1 agente · Mapa do emulador 62%") com o botão **abrir painel**. `/agentes` também abre.

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

## Tarefas em background

Comandos rodando em background (uma renderização, um build, um servidor) também aparecem na faixa, abaixo do agente que os iniciou. Se o comando imprime o próprio progresso (`Rendered 13914/16638`, `84%`), a barra usa esse número. O mod acha sozinho onde ler: a saída do comando, os logs para onde ele manda a saída (`> work/render.log`, `| tee build.log`) e qualquer log que o agente tenha conferido. Lê o arquivo mais recente a cada 2 segundos, então numa sequência (renderiza, depois masteriza) a barra acompanha cada etapa. Sem isso, a linha mostra só o tempo e a última linha impressa. A tarefa sai da lista quando termina.

## O que cada linha mostra

- **Nome curto** e o **tipo** em uma palavra (busca, plano, agente, comando), mais o tempo rodando.
- **Barra**, só quando há um número: a checklist do agente ou o progresso que o comando imprime. `≈` marca estimativa pelo histórico. Sem número, não há barra: só o que está sendo feito.
- **Etapa atual** da checklist, quando existe.
- **Ação atual** (o arquivo lido, o comando rodado, a última linha do log).

## Opcional: checklist na conversa principal

Nos modelos mais novos, o Claude Code não liga as ferramentas de checklist (TaskCreate e TaskUpdate) por padrão. Para que a conversa principal também tenha barra real, adicione ao `~/.claude/settings.json`:

```json
"env": { "CLAUDE_CODE_ENABLE_TODO_TOOLS": "1" }
```

Sem isso, a conversa principal usa a ferramenta `progress` do próprio mod.

## Requisitos

Claude Code com suporte a mods de hooks em TypeScript (versão 2.1.295 ou mais nova). A API ainda é early access e pode mudar entre versões.

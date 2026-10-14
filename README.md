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

## Tarefas em background

Comandos rodando em background (uma renderização, um build, um servidor) também aparecem na faixa, abaixo do agente que os iniciou. Se o comando imprime o próprio progresso (`Rendered 13914/16638`, `84%`), a barra usa esse número. O mod acha sozinho onde ler: a saída do comando, os logs para onde ele manda a saída (`> work/render.log`, `| tee build.log`) e qualquer log que o agente tenha conferido. Lê o arquivo mais recente a cada 2 segundos, então numa sequência (renderiza, depois masteriza) a barra acompanha cada etapa. Sem isso, a linha mostra só o tempo e a última linha impressa. A tarefa sai da lista quando termina.

## Comandos

- `/agentes` abre o painel com a checklist completa de cada agente e a base de cada número. O botão "minimizar" deixa a faixa numa linha só, com um botão "mostrar" pra voltar.

## Opcional: checklist na conversa principal

Nos modelos mais novos, o Claude Code não liga as ferramentas de checklist (TaskCreate e TaskUpdate) por padrão. Para que a conversa principal também tenha barra real, adicione ao `~/.claude/settings.json`:

```json
"env": { "CLAUDE_CODE_ENABLE_TODO_TOOLS": "1" }
```

Sem isso, a conversa principal usa a ferramenta `progress` do próprio mod.

## Requisitos

Claude Code com suporte a mods de hooks em TypeScript (versão 2.1.295 ou mais nova). A API ainda é early access e pode mudar entre versões.

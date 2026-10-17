# Desempenho: resultado das otimizações (antes e depois)

Data: 2026-10-17. Branch `mc/162dfec8`, a partir de `e6e3f49` (main). Relatório de origem: `/tmp/monoperf/RELATORIO-PERFORMANCE.md` (2026-10-16, base `e49a5ae`), não alterado.
Máquina: Apple M5, 10 núcleos, macOS (Darwin 27), Node 24.15.0, cargo 1.99.0. Motor de UI: WebKit do Playwright (build 2358, headless), o mesmo motor do WKWebView.

Metodologia: os mesmos scripts do diagnóstico, copiados e adaptados sem alterar os originais (`/tmp/monoperf/after/`: `drive.mjs`, `boot.mjs`, `closure.py`, `sizes.py`, mais `attrib.mjs` para atribuir bytes de cada chunk ao arquivo de origem e `measure_final.sh` que orquestra tudo). Antes e depois foram medidos no mesmo ciclo, intercalados (antes, depois, antes, depois), porque outra sessão carregava a máquina durante o trabalho; o load average em cada etapa está em `/tmp/monoperf/after/final_timeline.txt` (entre 3 e 12 durante a rodada final). "n" é o número de execuções; "dp" é o desvio-padrão populacional. Os números "antes" reproduzem os do relatório.

## Tabela resumo

| # | Gargalo | Métrica | Antes | Depois | Variação |
|---|---|---|---|---|---|
| 1 | Congelamento no 1º bloco de código | maior gap entre frames após o mount (20 turnos), n=5 por rodada, 2 rodadas | 897 ms (dp 14) / 922 ms (dp 73) | 47 ms (dp 4) / 36 ms (dp 18) | -95 % |
| 1 | idem, 300 turnos | mesmo | 890 ms / 890 ms | 28 ms / 28 ms | -97 % |
| 2 | Streaming com 300 turnos carregados | custo por atualização (média), n=790/812 e 906/1003 | 16,94 ms / 16,24 ms | 7,87 ms / 7,00 ms | -55 % |
| 2 | idem | gap entre frames (média) | 25,6 ms / 24,8 ms | 22,2 ms / 20,0 ms | -15 % |
| 2 | idem | p95 do custo por atualização | 29 ms / 20 ms | 15 ms / 11 ms | -47 % |
| 2 | Streaming na janela inicial (20 turnos) | custo por atualização | 3,53 ms / 2,47 ms | 1,59 ms / 1,55 ms | -48 % |
| 2 | Paginação de 280 turnos antigos | total por execução | 1.762 ms / 1.816 ms | 1.698 ms / 1.781 ms | -3 % (não atacado) |
| 3 | JS carregado no boot (fecho estático de `index.html` + `App`) | bruto / gzip, 8 arquivos | 3.426.978 / 1.074.188 B | 2.806.147 / 871.972 B | -18,1 % / -18,8 % |
| 3 | Boot (stub de IPC, workspace vazio), n=8 por rodada, 2 rodadas | `monocode:workspace-ready` | 112,8 ms (dp 27) / 104,1 ms (dp 9) | 73,8 ms (dp 8) / 75,2 ms (dp 11) | -31 % |
| 3 | idem | `monocode:ui-ready` | 398,6 ms (dp 37) / 387,1 ms (dp 14) | 356,5 ms (dp 10) / 360,8 ms (dp 14) | -9 % |
| 4 | Binário release (macOS arm64) | tamanho | 32.386.704 B (72.648 símbolos) | 22.359.920 B (374 símbolos) | -31 % |
| 5 | `git_diff_index` real (Rust), repositório de 1.351 arquivos, n=10 alternados | tempo por chamada | 101,7 ms (dp 6,7) | 11,2 ms (dp 0,5) com lado remoto em cache; 47,9 ms (dp 2,2) na chamada que o renova | -89 % / -53 % |
| 5 | idem, repositório de 20.323 arquivos (vscode) | tempo por chamada | 754,5 ms (dp 144) | 94,1 ms (dp 0,7) em cache; 603,6 ms (dp 2,3) renovando | -88 % / -20 % |
| 5 | Polling com a janela sem foco | intervalo | 2 s | 10 s (focar recarrega na hora) | -80 % de chamadas |

Sobre a coluna "Depois" do item 3, `ui-ready` inclui o fade fixo de 180 ms do splash e dois frames de rAF (`src/main.tsx`), então a parte que depende do JS é a diferença `workspace-ready`, onde a queda é de cerca de 30 ms (-31 %).

## 1. Congelamento no primeiro bloco de código

O que foi medido antes de decidir (todas as medições em WebKit, exceto onde indicado):

- O chunk `index.esm-*.js` (1,13 MB) que o relatório associou ao shiki é o `react-material-icon-theme` (ícones SVG do cabeçalho do bloco), carregado pelo `FileTypeIcon`; importá-lo custa 28 ms em Node. Não é a causa.
- A causa é a primeira tokenização de uma gramática pelo engine JavaScript do shiki: `createHighlighter` 4 a 20 ms, `loadLanguage(typescript)` 5 a 26 ms, e o primeiro `codeToTokens` em TypeScript 1,5 a 2,7 s sob carga (cerca de 0,9 s em repouso, o valor do relatório). O JavaScriptCore compila as regex da gramática na primeira execução de cada scanner. Com a fence em `text` o custo é o mesmo porque `highlightLanguageFor` troca `text` por `js`.
- Gramáticas pré-compiladas (`@shikijs/langs-precompiled` + `createJavaScriptRawEngine`): descartadas. Importar a gramática pré-compilada de TypeScript custou 1,2 a 1,6 s (parse de regex com flag `v`) e o primeiro `codeToTokens` continuou em 1,0 a 1,4 s; os tokens também não saíram idênticos aos do engine atual. O pacote foi removido.
- `target` do engine (`ES2018`/`ES2024`/`ES2025`) em Node: 411 a 674 ms, sem ganho relevante.
- Aquecimento fatiado por linha na main thread: a primeira linha de TypeScript sozinha custou 767 a 1.047 ms (scanner raiz), e algumas linhas seguintes 200 a 385 ms. Fatiar não limita o stall. Por linguagem, primeiro `codeToTokens` de um trecho representativo: `tsx` 1.067 ms, `css` 339, `cpp` 266, `vue` 244, `html` 153, `swift` 101, `php` 71, `yaml` 47, `go` 42; as demais abaixo de 35 ms.

Decisão, pelos números: mover a tokenização para um Web Worker (o projeto já usa um worker de módulo em `newThreadBackgroundEffects.worker.ts`) e aquecer `javascript`, `typescript` e `tsx` dentro do worker em idle depois do boot, na mesma lista de `preloadNavigationWhenIdle` de `App.tsx`.

Implementação:

- `src/features/files/editor/highlightEngine.ts` (novo): o tokenizador com o checkpoint de streaming (estado de gramática das linhas completas). Responde só as linhas depois das que a janela já tem (`reusedLines`), para que as linhas completas mantenham a identidade dos arrays de tokens e `HighlightedLine` mantenha seus elementos. As respostas saem em ordem de pedido, condição para os dois lados concordarem sobre qual é "a última fence".
- `src/features/files/editor/codeHighlight.worker.ts` (novo): entrada do worker.
- `src/features/files/editor/codeHighlightPlugin.ts`: mesma API (`createBoundedCodePlugin`, `boundedCode`), LRU e deduplicação de pedidos iguais; backend de worker com fallback para texto sem cor se o worker não subir; `warmUp`.
- `src/features/files/editor/shikiLanguages.ts` (gerado, com teste que o compara ao shiki instalado): lista de linguagens e aliases, para `supportsLanguage` não importar o bundle do shiki na main thread; isso também evitou emitir as 220 gramáticas duas vezes (o fallback inline que importava o engine foi restrito a testes, em `highlightInlineBackend.ts`).
- `vite.config.ts`: `worker.format = "es"`, para o worker carregar gramáticas e temas como chunks.

Testes: `codeHighlightPlugin.test.ts` (20 testes, os 11 antigos intactos) compara os tokens com um shiki de referência linha a linha enquanto a fence cresce, agora também pelo protocolo do worker (um `FakeWorker` roda o handler real), cobre pedidos sobrepostos de duas fences, a identidade das linhas completas, a queda do worker e o aquecimento. `tests/browser/code-highlight.spec.ts` (novo, Playwright): monta um transcript com um bloco TypeScript e exige tokens coloridos vindos do worker com o maior gap de frames abaixo de 250 ms; contra o código antigo falha com 1.404 ms.

## 2. Streaming com histórico longo

Decomposição medida (fixture do relatório, método `streamSplit` adicionado ao fixture local, 2 execuções):

| Cenário | React (`flushSync`) | Layout (`scrollHeight`) |
|---|---|---|
| 20 turnos, antes | 1,8 a 2,0 ms | 0,4 ms |
| 300 turnos, antes | 10,7 ms | 4,8 a 5,0 ms |
| 300 turnos, depois | 1,3 a 1,4 ms | 4,9 a 5,4 ms |

O React dominava: cada turno era construído inline no render de `AgentTranscript`, então cada flush reconstruía os elementos de todos os turnos carregados. O corpo do turno foi movido, sem alterações de lógica, para um componente `TranscriptTurn` memoizado (`src/features/sessions/ui/AgentTranscript.tsx`), com props primitivas ou estáveis: o próximo turno entra como seu bloco inicial (tudo o que `stacksAfterReaction` lê), `backgroundTasks` só chega ao turno ativo, o resultado da busca só ao turno que o contém. Como `SessionPane` passa arrow functions novas a cada render, o transcript embrulha os callbacks opcionais em funções estáveis que chamam a última versão.

Teste de regressão: `AgentTranscript.performance.test.ts` faz três atualizações de streaming com callbacks inline e exige que só um turno renderize em cada (contado por `artifactCards`, chamado uma vez por render de turno). Os 56 arquivos de teste do transcript (488 testes) e os testes de navegador de rolagem (`transcript-scroll`, `tab-revisit`, `markdown-performance`, 10 testes em WebKit) passam.

Avaliação de virtualização e paginação por janela, pedida na tarefa: o DOM continua com cerca de 157 nós por turno (47,7 mil nós com 300 turnos), e a parte de layout (cerca de 5 ms) permanece. Experimento no fixture: `content-visibility: auto` com `contain-intrinsic-block-size` igual à altura medida em todos os turnos menos os 10 últimos reduziu o layout para 1,8 a 2,5 ms (cerca de -45 %), sem mudar `scrollHeight`. Não foi adotado nesta entrega porque o CSS do projeto desliga `content-visibility: auto` de propósito (alturas estimadas alteravam a faixa de rolagem durante gestos) e porque descartar turnos do DOM (placeholder com altura medida) perde o estado interno dos blocos (saídas de ferramenta abertas, "mostrar mais"), quebra a seleção de texto que atravessa turnos colapsados e exige que a busca expanda turnos antes de medir. Fica como hipótese com números: o teto de ganho adicional é de cerca de 2,5 a 3 ms por atualização com 300 turnos. A paginação (240 ms por página de 20 turnos) não foi atacada.

## 3. Boot

Atribuição por origem do JS do boot (sourcemaps, `attrib.mjs`), antes: chunk `App` 1,66 MB com 253 KB de CodeMirror (`@codemirror/view`, `state`, `search`), 166 KB do `CHANGELOG.md` como string, 200 KB de adaptadores de provedores; chunk compartilhado "mermaid" 949 KB com parse5 (126 KB), streamdown (65 KB), núcleo do shiki e engines (cerca de 165 KB), marked (41 KB) e a pilha remark/rehype.

Fecho estático do boot por etapa (bruto / gzip):

| Etapa | Bytes | Variação |
|---|---|---|
| Antes | 3.426.978 / 1.074.188 | |
| Shiki no worker (item 1) | 3.243.909 / 1.015.992 | -183 KB |
| CodeMirror fora do boot (`editorFind.ts`) | 2.972.819 / 929.197 | -271 KB |
| Changelog sob demanda | 2.806.147 / 871.972 | -167 KB |

Implementado:

- `src/features/files/editor/editorFind.ts` (novo): os atalhos de busca da janela sem CodeMirror. `App.tsx` importava `handleEditorFindKey`/`openFindInActiveEditor` de `editorSearch.ts`, que puxa CodeMirror inteiro. O shim executa a parte que não precisa de editor (pickers, busca do preview de arquivo, atalhos padrão engolidos quando reatribuídos) e delega a `editorSearch` quando este se registra, o que o preload em idle depois do boot dispara. Teste: `editorFind.test.ts`.
- `src/app/model/releaseNotes.ts`: o changelog passa a ser `import()` dinâmico; `WhatsNewDialog` e `ReleaseNotesSurface` leem por `useChangelog()` (`src/app/hooks/useChangelog.ts`) e não renderizam nada até ele chegar; abrir pelo menu aguarda o carregamento. Teste ajustado em `WhatsNewDialog.test.ts`.

Já eram sob demanda e não foram tocados: editor (`FileEditor`), terminal (`TerminalView`), mermaid, emoji, configurações, inbox, busca, notas, automações; "Azure" é só o modelo `azureDevOps.ts` (12 KB) dentro do inbox. O que continua no boot e poderia sair, como hipótese não medida: adaptadores de provedores (cerca de 300 KB entre `App` e `slashCommands`), a pilha de Markdown (cerca de 400 KB no chunk compartilhado, necessária assim que uma sessão restaurada é exibida, o caso comum) e as views de Mono (71 KB).

Total de JS do `dist`: 21.557.456 B em 435 arquivos antes, 21.577.648 B em 439 depois (worker, chunk do changelog, módulos novos), sem duplicação de gramáticas.

Limite: o boot medido usa stub de IPC e workspace vazio (como no relatório); o efeito no app real, com sessões restauradas, não foi medido.

## 4. Binário release

`Cargo.toml` (workspace): `[profile.release] strip = true`. Thin LTO não entrou (o relatório mediu 169,6 s contra 174,9 s de build e 23,3 MB, sem ganho). O projeto não lê símbolos de volta: não há `std::backtrace`, hooks de panic nem relatórios de crash em `src-tauri`; panics imprimem a mensagem sem backtrace a menos que `RUST_BACKTRACE` esteja definido. Resultado em `cargo build --release` a partir deste branch: 32.386.704 B (binário do relatório, sem strip) para 22.359.920 B; `nm` passa de 72.648 símbolos para 374. O `tauri build` completo (bundle `.app`/`.dmg`) não foi executado, e o app não foi aberto. O `tauri.conf.json` não foi alterado.

## 5. Polling de git

O `git_diff_index` real rodava cerca de 13 processos por chamada: cinco `git diff` e um `ls-files` para os arquivos, e `rev-parse`, `symbolic-ref`, `remote`, upstream, branch padrão, dois `rev-list --count` e `for-each-ref --contains` para o chrome.

Implementado em `src-tauri/src/fs.rs`:

- Uma chamada `git status --porcelain=v2 -z --branch --untracked-files=all --no-renames -- .` dá os arquivos com estado de índice e árvore (X/Y), o branch, o HEAD, o upstream e ahead/behind. `git diff --numstat HEAD` roda só quando há arquivo rastreado alterado (contagem de linhas); arquivos não rastreados continuam contados por leitura, como antes. `rev-parse --show-prefix` roda só quando a pasta aberta não é a raiz do repositório.
- O lado remoto (nome do remote, branch padrão, à frente do padrão, HEAD enviado) fica em cache por repositório por 10 s. O cache cai na hora quando um comando git executado pelo app termina com sucesso (`git_checked`: push, pull, commit, checkout, stash) e quando as refs em disco mudam (`packed-refs`, `FETCH_HEAD` e o mtime dos diretórios sob `refs/heads` e `refs/remotes`), o que cobre push e fetch feitos num terminal. O limite de 10 s fica para formatos de refs que o fingerprint não vê (reftable).
- A leitura antiga ficou no módulo de testes (`legacy_git_diff_index_for`) e novos testes exigem igualdade entre as duas leituras: modificado, staged e modificado de novo, apagado na árvore, apagado no índice, renomeado (`D` + `A`), não rastreado, nome com espaço, pasta aninhada, branch sem commits, HEAD destacado, repositório com remote (HEAD enviado, à frente, push pelo app e push externo). Mais um teste de parse do formato v2 com entradas `1`, `2`, `u`, `?`, `!`.
- Frontend (`GitChangesPanel.tsx`): o intervalo de 2 s continua com a janela em foco; sem foco, só a cada 5º tick (10 s), e o evento `focus` já recarrega na hora. Só o painel do projeto ativo faz polling (`enabled={panelOpen}`), como antes; `useGitFileStatuses` e `useProjectDiffStats` são por evento. Teste em `GitChangesPanel.test.ts`.

Medição com o teste ignorado `git_diff_index_bench` (`MONOCODE_GIT_BENCH_REPO=<repo> cargo test git_diff_index_bench -- --ignored --nocapture`), que alterna as duas leituras na mesma execução:

| Repositório | Antes (leitura antiga) | Depois, lado remoto em cache | Depois, chamada que renova o cache |
|---|---|---|---|
| monocode (1.351 arquivos) | 101,7 ms (dp 6,7) | 11,2 ms (dp 0,5) | 47,9 ms (dp 2,2) |
| vscode (20.323 arquivos) | 754,5 ms (dp 144) | 94,1 ms (dp 0,7) | 603,6 ms (dp 2,3) |

Aproximação em shell, mesmo `gitbench.sh` do relatório (7 processos) contra um só `git status --porcelain=v2`, 5 execuções: monocode 70 a 85 ms contra 25 a 26 ms; vscode 186 a 365 ms contra 107 a 109 ms. A chamada que renova o cache no vscode continua cara porque `for-each-ref --contains HEAD refs/remotes` e os `rev-list --count` percorrem o histórico; com cache de 10 s e polling de 2 s, o custo médio por poll em foco cai de 754 ms para cerca de 196 ms (4 chamadas de 94 ms e 1 de 604 ms).

## O que não melhorou, ou piorou

- Paginação por scroll (240 ms por página de 20 turnos): inalterada; o custo é a construção dos turnos novos.
- Layout por atualização com 300 turnos (cerca de 5 ms): inalterado; ver a avaliação no item 2.
- Primeiro bloco de código: a cor chega assíncrona, como antes (o bloco aparece em texto simples e colore em seguida); com o aquecimento em idle a gramática de JS/TS/TSX já está compilada quando o primeiro bloco aparece. Para outras linguagens a compilação ocorre no worker na primeira fence, sem travar a janela.
- Falha do worker de highlight: nesse caso o código fica sem cor (texto simples, com log no console). Antes, a falha equivalente seria uma exceção no highlight. O engine não é mais empacotado para a main thread porque isso emitia as gramáticas duas vezes (10 MB a mais no `dist`).
- Lado remoto do painel de git: em repositórios com refs em reftable, mudanças feitas fora do app aparecem em até 10 s.
- `dist` total: +20 KB.

## Validação

- `npm run check:web`: 486 arquivos de teste passaram, 2 ignorados (já ignorados na main), 5.391 testes passaram, 13 ignorados; `tsc --noEmit` limpo.
- `npm run check:rust`: `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings` e `cargo test` (659 testes; 2 ignorados, um deles o bench) passam. Uma execução intermediária falhou em `git_sync_marks_head_pushed_without_upstream` por causa do cache do lado remoto, o que levou ao fingerprint das refs; não existia na main.
- Testes de navegador (WebKit 2358, config local `playwright.local-webkit.config.ts`, não commitada): `code-highlight` (novo), `transcript-scroll`, `tab-revisit`, `markdown-performance`: 11 testes passam. Chromium não está instalado nesta máquina.

## Arquivos tocados

Transcript e lista de mensagens (atenção para o merge com `mc/redesign-composer-model-slider`): `src/features/sessions/ui/AgentTranscript.tsx` (corpo do turno movido para `TranscriptTurn`; o diff é grande por ser uma movimentação), `src/features/sessions/ui/AgentTranscript.performance.test.ts`. Não foram tocados `Composer.tsx`, `ModelPicker.tsx`, `ModelSettings.tsx`, `SessionPane.tsx` nem o slider.

Também tocados: `src/app/App.tsx` (três imports e duas entradas na lista de preload em idle, mais o `onOpenWhatsNew` assíncrono), `src/app/model/releaseNotes.ts`, `src/app/hooks/useChangelog.ts`, `src/app/shell/WhatsNewDialog.tsx` e teste, `src/app/ui/ReleaseNotesSurface.tsx`, `src/features/files/editor/{codeHighlightPlugin.ts,codeHighlight.worker.ts,highlightEngine.ts,highlightInlineBackend.ts,shikiLanguages.ts,editorFind.ts,editorSearch.ts}` e testes, `src/features/source-control/ui/GitChangesPanel.tsx` e teste, `src-tauri/src/fs.rs`, `Cargo.toml`, `vite.config.ts`, `tests/browser/code-highlight.{html,tsx,spec.ts}`.

Não commitados, locais: `scripts/perf-tmp/` (fixture do diagnóstico, com os métodos `streamSplit` e a página de sonda), `playwright.local-webkit.config.ts`.

## Hipóteses que continuam sem medição

Custo do corpo de `App` por flush de streaming no app real; latência real do IPC; editor e terminal; o efeito do boot menor no app real com sessões restauradas; a parte de layout do streaming com `content-visibility` exato (experimento acima, não adotado).

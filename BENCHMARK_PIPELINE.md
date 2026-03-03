# Pipeline completo do benchmark OABench

Este documento define o processo fim a fim para rodar o benchmark da **1ª fase da OAB** usando as **3 provas mais recentes**.

## 1) Objetivo

Comparar modelos de IA pela **taxa de acerto** em questões objetivas da OAB, isolando o impacto de:

- reasoning (com vs sem)
- web search/grounding (com vs sem)

## 2) Escopo e critérios

- Provas: últimas 3 edições disponíveis da 1ª fase.
- Unidade de avaliação: questão objetiva.
- Saída esperada por questão: alternativa final única (`A`, `B`, `C` ou `D`).
- Métrica principal: `acuracia = acertos / total_questoes`.

## 3) Matriz experimental (2x2)

Para cada modelo, executar os 4 cenários:

1. Sem reasoning + sem web search
2. Com reasoning + sem web search
3. Sem reasoning + com web search
4. Com reasoning + com web search

## 4) Estrutura de dados recomendada

Organize os dados em JSONL (uma questão por linha):

```json
{
  "exam_id": "oab_42",
  "question_id": "oab_42_q001",
  "statement": "Enunciado completo...",
  "options": {
    "A": "Texto da alternativa A",
    "B": "Texto da alternativa B",
    "C": "Texto da alternativa C",
    "D": "Texto da alternativa D"
  },
  "answer_key": "C",
  "source": "https://..."
}
```

Arquivos mínimos:

- `data/raw/` -> provas originais (PDF/HTML/TXT)
- `data/processed/questions.jsonl` -> dataset normalizado
- `data/processed/answer_key.jsonl` -> gabarito normalizado (separado, opcional)

## 5) Preparação do dataset

1. Coletar as 3 provas e respectivos gabaritos oficiais.
2. Extrair enunciados e alternativas para formato estruturado.
3. Garantir que `question_id` seja único e estável.
4. Validar consistência:
   - toda questão tem 4 alternativas
   - toda questão tem gabarito válido (A/B/C/D)
   - sem duplicação de `question_id`

## 6) Contrato de prompt por cenário

Use o mesmo prompt-base em todos os cenários, mudando apenas os toggles:

- `reasoning_enabled: true|false`
- `web_search_enabled: true|false`

Requisitos de saída do modelo:

- Sempre retornar alternativa final em formato parseável.
- Formato recomendado:

```text
FINAL_ANSWER: <A|B|C|D>
```

Isso reduz erro de parsing e padroniza scoring.

## 7) Execução do benchmark

Para cada combinação de:

- modelo
- cenário (2x2)
- prova (3 provas)
- questão

execute uma inferência e salve o resultado bruto.

Campos mínimos de log por inferência:

- `run_id`
- `timestamp`
- `model`
- `exam_id`
- `question_id`
- `reasoning_enabled`
- `web_search_enabled`
- `raw_response`
- `parsed_answer`
- `latency_ms`
- `token_usage` (se disponível)
- `error` (se falha)

## 8) Parsing e scoring

1. Extrair `parsed_answer` da resposta bruta.
2. Se não for A/B/C/D, marcar como inválida.
3. Comparar `parsed_answer` com `answer_key`.
4. Definir `is_correct`:
   - `1` para acerto
   - `0` para erro ou inválida

## 9) Agregação de métricas

Gerar ao menos estes recortes:

- Por modelo e cenário (principal)
- Por modelo, cenário e prova
- Geral por modelo (média dos cenários)

Métricas recomendadas:

- acurácia (`acertos/total`)
- total de inválidas
- latência média

## 10) Relatórios e artefatos

Gerar os seguintes artefatos versionados:

- `results/runs/<run_id>/inferences.jsonl`
- `results/runs/<run_id>/scored.jsonl`
- `results/runs/<run_id>/summary.csv`
- `results/latest/leaderboard.csv`

`leaderboard.csv` mínimo:

- `model`
- `reasoning_enabled`
- `web_search_enabled`
- `correct`
- `total`
- `accuracy`

## 11) Controle de qualidade

- Reprodutibilidade:
  - fixar versão do modelo quando possível
  - salvar configuração completa da execução
- Robustez:
  - retries com limite para falhas transitórias de API
  - timeout por questão
- Auditoria:
  - manter `raw_response` para inspeção posterior

## 12) Fluxo operacional (checklist)

1. Atualizar dataset das 3 provas (`data/processed/questions.jsonl`).
2. Validar integridade dos dados.
3. Definir lista de modelos a testar.
4. Rodar 4 cenários para cada modelo.
5. Fazer parsing padronizado da resposta final.
6. Calcular acurácia por cenário.
7. Publicar leaderboard consolidado.
8. Revisar casos inválidos e ajustar parser/prompt, se necessário.

## 13) Definição de sucesso do benchmark

Um run do benchmark é considerado completo quando:

- todos os modelos rodaram nos 4 cenários
- as 3 provas foram processadas em cada cenário
- o relatório final contém acurácia comparável entre modelos
- os artefatos de execução e scoring foram persistidos

## 14) Download automatizado das provas (Bun)

Para materializar as 3 provas objetivas mais recentes **com gabarito** em `data/`:

```bash
bun run download:oab-provas
```

Saídas esperadas:

- `data/oab/exams/<exame>/prova-objetiva-tipo1.pdf` (3 arquivos)
- `data/oab/exams/<exame>/gabarito.pdf` (3 arquivos)
- `data/oab/runs/run-<timestamp>.json`
- `data/oab/latest-run.json`

Para extrair as questões em JSON por prova:

```bash
bun run parse:oab-provas
```

Saídas por exame:

- `data/oab/exams/<exame>/questions.json` (array de questões no schema v1)
- `data/oab/exams/<exame>/answer_key.json` (qid + alternativa correta/anulada)

Para validar consistência de `questions.json` e `answer_key.json`:

```bash
bun run validate:oab-json
```

Validações principais:

- quantidade de itens (80 questões e 80 respostas por prova)
- integridade de schema/campos críticos
- consistência entre `questions` e `answer_key` por `qid`
- coerência de anuladas (`correct: null` e `status.question`)
- conferência de `sha256` com os PDFs locais de prova e gabarito

Artefatos de validação em `data/oab/runs/`:

- `validation-summary-<runId>.json`
- `latest-validation-summary.json`

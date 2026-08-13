-- projects.llm_model: default passa a ser gemini-3.7-flash (GA) e os projetos
-- que apontavam para a linha Gemini 3 preview sao migrados junto.
--
-- Motivacao: uma run de producao gastou 26 chamadas e gravou 26 respostas
-- vazias antes de estourar "Run comprometida: 26/26 docs (100%)". O provider
-- respondeu 404 NOT_FOUND para `models/gemini-3-flash` — um ID que nunca
-- existiu na API. O registry do frontend oferecia "Gemini 3 Flash" apontando
-- para `gemini-3-flash`, quando o preview real chamava-se
-- `gemini-3-flash-preview` (o proprio default desta coluna desde a 001).
-- Selecionar aquela opcao gravava o ID morto aqui, e o backend passava a
-- string crua ao provider sem validacao em ponto algum do caminho.
--
-- Censo antes desta migration (9 projetos, todos google_genai):
--   1x gemini-3-flash          -- inexistente, e o que estourou
--   8x gemini-3-flash-preview  -- existe, mas ja e preview legado
--
-- O valor tem de acompanhar `defaultModelForProvider("google_genai")` em
-- frontend/src/lib/model-registry.ts — o SQL nao deriva do TypeScript, entao a
-- proxima troca de default precisa mexer nos dois lados.
--
-- Respostas ja gravadas nao sao tocadas: `responses.respondent_name` guarda o
-- modelo historico de cada run, e `publish_latest_llm_response` desmarca
-- is_latest por documento sem olhar respondent_name. Trocar o modelo do projeto
-- substitui a resposta LLM corrente no proximo run, como um re-run comum — nao
-- cria respondente paralelo nem par de comparacao novo.

ALTER TABLE public.projects
  ALTER COLUMN llm_model SET DEFAULT 'gemini-3.7-flash';

-- Escopo restrito a google_genai para nao tocar projeto que tenha migrado de
-- provider e por acaso carregue um destes nomes.
UPDATE public.projects
   SET llm_model = 'gemini-3.7-flash'
 WHERE llm_provider = 'google_genai'
   AND llm_model IN ('gemini-3-flash', 'gemini-3-flash-preview');

# Por que o LLM diverge dos codificadores humanos

Uma pesquisadora perguntou se dá para pedir ao LLM que veja as classificações anteriores na rodada de comparação e aprenda com os próprios erros. A intuição que acompanhava a pergunta estava correta e é o ponto de partida deste documento: a divergência pode vir de "algo implícito para os humanos que precisa ser explicitado para os LLMs". Ao medir, encontrei uma versão mais forte dessa hipótese. Em boa parte dos casos o implícito não existe — nem para os humanos. Duas pessoas treinadas, lendo o mesmo documento, respondem coisas diferentes; o modelo escolhe uma das respostas possíveis e é contabilizado como erro.

A análise cobre o projeto **Zolgensma - Judiciário**, na rodada "Teste 2 do formulário (v2)": 23 documentos, 25 perguntas comparáveis, 40 codificações humanas de 7 pesquisadores e uma execução completa do LLM (`gemini-3.7-flash`, 14 de agosto de 2026). O projeto **Zolgensma** (pareceres) serve de contraprova, com 195 documentos. O relatório com os números por pergunta acompanha este texto; o script que o gera vive fora do repositório, em `pipeline-processos/analise-divergencia/`.

## O achado principal

**Em nenhuma das 25 perguntas o LLM erra significativamente mais do que um codificador humano erraria.** A taxa global de divergência do modelo contra o gabarito é de 13,4% — 51 células em 380. No projeto de pareceres, 26,4%, com o mesmo resultado qualitativo: nenhuma pergunta em que o modelo seja o gargalo.

Esse número é bem menor do que o que circulava. Um levantamento anterior, de maio, apontava 20,5% de erro no projeto de pareceres e taxas de até 83% em perguntas específicas. A diferença não está no modelo, e sim no denominador. A fila de Comparação só apresenta ao revisor as células em que os codificadores já divergiram; medir a taxa de erro apenas ali responde a outra pergunta — com que frequência o modelo diverge do gabarito **dado que já houve divergência**. Com dois codificadores por documento, essa medida é 100% por construção: se A e B discordam e o veredito escolhe A, sobra B, que necessariamente diverge. Incluir as células em que os codificadores concordaram, e cujo consenso funciona como gabarito, é o que torna o número interpretável.

Por isso o relatório traz, ao lado da taxa de erro do modelo, o **piso de ruído**: a chance de um codificador humano sorteado divergir do gabarito naquela pergunta. É o denominador honesto. Onde o piso é 76%, uma taxa de 6% do modelo não é um defeito — é o oposto.

O caso mais eloquente é `q10_off_label`. A concordância entre os codificadores é de 29%, com α de Krippendorff de +0,29; o piso de ruído chega a 76%. O LLM diverge do gabarito em 6% das células. Nessa pergunta o modelo é mais consistente do que as pessoas. O mesmo padrão, em menor escala, aparece em `q20`, `q26` e `q14`.

## Seis perguntas em que o instrumento não sustenta a medida

Uso α de Krippendorff para medir concordância. É um coeficiente que desconta a concordância que ocorreria por acaso: 1,0 significa acordo perfeito, 0 significa que os codificadores estão respondendo tão consistentemente quanto sorteio, e valores negativos indicam desacordo sistemático. A convenção da área trata 0,667 como o piso do que se pode usar em pesquisa. Seis perguntas do Judiciário ficam abaixo dele.

**`q28_fontes_evidencia`** (α = +0,09) é a mais grave. Concordância de 12% entre codificadores — praticamente sorteio. Enquanto ela estiver assim, nenhum número derivado dela significa alguma coisa, e a taxa de 93% de divergência do LLM ali é irrelevante.

**`q4_doenca_paciente`** (concordância de 29%) e **`q3_medicamento`** (65%) são campos de transcrição, e o problema neles é de outra natureza. O enunciado pede para copiar a redação exata do documento, mas o documento cita a doença e o medicamento de várias formas, em pontos diferentes, e não há regra dizendo qual ocorrência copiar. O LLM transcreveu "Nusinersena (Spinraza) 12mg", com a dose; os dois codificadores escreveram "Nusinersena (Spinraza)", sem ela. Ninguém errou. Em `q4`, que tem subcampos para CID e nome da doença, parte das pessoas preenche o CID e parte deixa em branco — e a comparação por igualdade literal transforma isso em divergência.

**`q25_citacao_natjus_decisao`** (α = +0,44) oferece uma gradação — "somente cita a decisão" contra "cita e discute os argumentos" — sem definir quanto de discussão já conta como discussão. É uma régua sem marcas.

**`q21_questionou_merito_negativa`** (α = +0,58) coloca três categorias negativas para competir pelo mesmo caso: "não questionou", "não se aplica, porque não houve negativa administrativa" e "não informado". Num documento, os codificadores responderam "Sim, questionou" e "Não questionou", enquanto o LLM respondeu "Não informado" — três respostas distintas para o mesmo texto, cada uma defensável sob uma leitura diferente de qual categoria tem precedência.

## O padrão que mais rende correção: ausência não é negação

Descontadas as perguntas em que os codificadores não convergem, sobra um padrão recorrente e barato de corrigir. O modelo e as pessoas discordam sobre **se é permitido inferir**.

Em `q24_natjus_converge_conitec`, a concordância humana é de 91% e o LLM diverge em 20% das células. Nos dois casos, a justificativa do modelo é explícita sobre o motivo: "a sentença não discute explicitamente se a conclusão do parecer do NatJus coincide ou diverge formalmente da posição da Conitec". O modelo exigiu menção literal e respondeu "Não informado"; os codificadores compararam as duas posições por conta própria e responderam "Sim".

Em `q22_nota_tecnica_natjus`, o mesmo: o LLM lê a conclusão da nota técnica, julga que ela não recomenda e responde "Sim, mas NAT-JUS NÃO recomenda"; parte dos codificadores responde "Sim, mas não é possível saber se recomenda ou não".

O detalhe que importa é que **a direção não é constante**. No projeto de pareceres, o padrão aparece invertido: em `q9_indicacao_conforme_anvisa`, o LLM inferiu ("o medicamento está indicado em bula para menores de 2 anos, e a autora tem 1 ano e 3 meses, logo é on-label") onde cinco de seis codificadores exigiram menção explícita e responderam "Não informado". Ora o modelo é mais literal que as pessoas, ora menos.

Isso descarta a leitura de que o modelo tem um viés fixo a ser compensado. O que existe é uma **regra ausente do livro de códigos**. Enquanto ela não for escrita, cada leitor — humano ou máquina — resolve a lacuna do seu jeito, e a divergência resultante é ruído do instrumento, não sinal sobre os documentos.

## Sobre a pergunta original: o LLM não aprende entre rodadas

Não há aprendizado entre execuções. O modelo não é retreinado, não guarda memória de uma rodada para outra e chega a cada documento sem nenhum registro do que respondeu antes. O que existe é aprendizado em contexto: o que estiver no prompt vale para aquela chamada, e só para ela.

Então "mostrar ao LLM as classificações anteriores" só pode significar uma de duas coisas.

A primeira é colar no prompt exemplos de documentos já resolvidos, o que se chama *few-shot*. Não recomendo, por duas razões. A primeira é metodológica: se o modelo vê o gabarito de parte dos documentos, a concordância medida entre ele e os humanos deixa de ser auditável — não dá mais para distinguir competência de reprodução do que foi mostrado, e o número perde valor para publicação. A segunda é mais direta: nas seis perguntas problemáticas o gabarito é inconsistente, então o *few-shot* ensinaria o modelo a reproduzir a inconsistência dos codificadores. Melhorar a taxa de concordância dessa forma tornaria o modelo mais parecido com um humano médio nesse conjunto — inclusive nos erros.

A segunda leitura é converter os erros em **regras de decisão explícitas** no enunciado e nas instruções. Essa funciona, e é o caminho que recomendo. Na prática é melhorar o livro de códigos: a mesma correção que faria dois codificadores humanos convergirem faz o modelo convergir com eles. É por isso que este documento trata primeiro do instrumento e só depois do modelo — não por ordem de importância retórica, mas porque a correção é a mesma.

## O que fazer, em ordem de retorno

**Primeiro, escrever a regra de literalidade.** Uma instrução geral, aplicável a todas as perguntas, definindo quando é permitido inferir e quando a resposta exige afirmação expressa no documento. É a correção mais barata do conjunto e ataca o padrão que mais aparece. Ela entra em Configurar → Instruções adicionais, campo que alimenta o prompt do projeto, e o mesmo texto deve ir para o material de treinamento dos codificadores — a regra não vale só para a máquina.

**Segundo, declarar precedência entre categorias negativas.** Onde convivem "não", "não se aplica" e "não informado", a pergunta precisa dizer qual vence quando mais de uma se aplica, preferencialmente como sequência de decisão: verifique X; se não houver, verifique Y; caso contrário, responda Z. Vale para `q21`, `q22` e `q25`.

**Terceiro, dar regra de canonicalização aos campos de transcrição.** Em `q3` e `q4`, definir qual ocorrência copiar (a primeira do documento, a do dispositivo, a mais completa) e o que fica de fora — dose, apresentação, marca registrada. Sem isso, esses campos vão continuar produzindo divergência de recorte que não tem nada a ver com o conteúdo.

**Quarto, reconstruir `q28_fontes_evidencia`.** Com α de +0,09, não é caso de ajustar o enunciado. As opções precisam ser revistas de raiz, com definição do que conta como cada fonte, e a pergunta deveria ser recodificada num pequeno conjunto-piloto antes de voltar à coleta.

**Quinto, calibrar antes de coletar.** Antes de a próxima rodada começar, vale codificar de cinco a dez documentos em conjunto, comparar as respostas e escrever as regras que aparecerem. É o momento mais barato de descobrir que uma pergunta mede duas coisas ao mesmo tempo.

Duas providências de configuração fecham a lista. O modelo `gemini-3-flash`, oferecido na interface, não é servido pelo provedor e devolve erro — foi o que perdeu a execução de 13 de agosto. Convém conferir que o modelo selecionado responde antes de disparar uma coleta inteira. E a temperatura está em 1,0: a execução de 14 de agosto completou assim, então não há evidência de que isso tenha causado falha, mas o efeito plausível sobre a estabilidade entre execuções pode ser medido rodando o mesmo conjunto duas vezes com a mesma configuração e comparando — não custa quase nada e responde a pergunta de vez.

## O que já existe na plataforma e está sendo subutilizado

A aba **Revisões → LLM Insights** já cruza as respostas do modelo com os vereditos e lista onde ele divergiu, com a justificativa que ele deu. Dali dá para editar o enunciado, a orientação e o prompt de justificativa da pergunta sem sair da tela. É o caminho mais curto entre observar um erro e corrigir a causa.

O campo **"Registrar ambiguidades"**, que pode ser ligado em Configurar, faz o modelo apontar onde ficou em dúvida. Esses registros aparecem no feed de Comentários. Numa pergunta com α baixo, é uma triagem barata de onde o enunciado está falhando.

Há ainda um ativo desperdiçado. No modo de auto-revisão, quando o árbitro decide a favor do LLM contra o codificador humano, o formulário **exige** que ele escreva o que faltava explicitar na pergunta. O projeto de pareceres decidiu 37 arbitragens a favor do modelo e acumulou 35 desses textos. São exatamente o registro do implícito que este documento procura, escritos por quem estava com o documento na frente — e nunca foram lidos em conjunto. Eles estão compilados no relatório que acompanha este texto.

## Duas limitações que afetam a leitura dos números

**O gabarito não é independente do LLM.** Na tela de comparação, o card do modelo é identificado, e o revisor sabe qual resposta é dele ao decidir. No projeto de pareceres, o veredito coincidiu com a resposta do LLM em 315 células. Onde isso acontece, o modelo acerta por construção. Corrigi o efeito direto publicando também a taxa de erro que exclui essas células — o mesmo tratamento que apliquei do lado humano, excluindo o codificador cuja resposta virou gabarito. O que esse ajuste não corrige é a influência sobre o julgamento do revisor, que nenhum cálculo alcança.

A correção é de desenho de coleta, e a plataforma já tem a peça necessária: o modo de arbitragem com fase cega, em que o árbitro decide sem saber qual resposta é do modelo, antes de ver as justificativas. Recomendo ativá-lo nas próximas rodadas em que a concordância humano-máquina for um resultado a reportar. Sem isso, a taxa de concordância descreve um processo em que o revisor pôde ser influenciado, e essa ressalva vai ter que acompanhar o número em qualquer publicação.

**Os documentos com mais de um codificador não são amostra aleatória.** Foram escolhidos por atribuição, não sorteados da população de documentos do projeto. As taxas descrevem este conjunto e não se generalizam sem cuidado. Se a concordância for um resultado a publicar, o caminho é sortear um subconjunto de documentos para dupla codificação, em vez de aproveitar os que já têm.

## Uma nota sobre as rodadas

Durante a análise descobri que iniciar uma nova rodada de codificação retira de circulação todas as respostas da rodada anterior. No Zolgensma - Judiciário isso aconteceu duas vezes, e hoje as 185 respostas do projeto estão nessa condição, com a rodada corrente vazia. Os dados continuam íntegros no banco — a análise deste documento foi feita sobre eles —, mas as telas de Comparação, Gabarito e Auto-revisão mostram o projeto vazio, e as auto-revisões pendentes daquela rodada foram apagadas, não arquivadas.

O comportamento é o desenhado, e o diálogo de sorteio avisa que "as respostas anteriores ficam no histórico". O aviso, porém, não deixa claro o tamanho da consequência. Registro aqui porque afeta quem for retomar o trabalho neste projeto e porque explica por que a rodada de LLM de 14 de agosto não aparece na interface.

Registro também, pelo mesmo motivo, que rodadas não devem ser somadas em análise. Cada uma é uma coleta separada, com sua versão do formulário e seu conjunto de codificadores. No Judiciário, somá-las faz 23 documentos parecerem ter quatro codificadores cada; separadas, a "Rodada inicial" tem 23 documentos com exatamente dois codificadores e o "Teste 2" tem 17 — e só o "Teste 2" tem execução do LLM.

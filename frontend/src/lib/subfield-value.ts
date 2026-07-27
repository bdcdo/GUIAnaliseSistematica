// A forma que um campo com `subfields` produz, e o que fazer com um valor que
// não está nela.
//
// Um campo `text` pode ganhar subcampos depois que respostas já foram
// coletadas; as antigas seguem gravadas como string. A pergunta "este valor
// está na forma do grupo?" era respondida em dois lugares — na régua de
// completude e no renderizador de codificação — e cada um tirava dela uma
// conclusão oposta: a régua anistiava o valor ("respondido"), o renderizador o
// colapsava em `{}` ("não sei exibir"). O resultado era a pergunta aparecer com
// ✓ e a tela vazia, e a primeira tecla digitada apagar a resposta (#607). A
// fronteira mora aqui para que os dois lados leiam o mesmo fato.
//
// Módulo puro/client-safe (sem React), no molde de `other-option.ts`, para ser
// importado tanto em componentes 'use client' quanto em server actions e testes.
import { NOT_INFORMED } from "@/lib/sentinels";

// A forma do grupo. `null` é objeto para o `typeof`, daí o teste explícito: sem
// ele, um valor nulo seria tratado como registro e estouraria na primeira
// leitura de subcampo.
export function isSubfieldRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// O texto de uma resposta coletada antes de o campo virar grupo, ou `null`
// quando não há texto legado que valha exibir.
//
// Este predicado é mais ESTREITO que a anistia da régua de completude, de
// propósito, e os dois não são complementares. A régua é permissiva por
// decreto: anistia tudo que não seja registro — número, boolean, array —
// porque rejeitar rebaixaria codificações já concluídas (#606). Aqui a régua é
// a evidência: só existe algo a mostrar, e a mostrar verbatim, quando o valor é
// texto de fato. Um número solto num campo-grupo não é resposta legada
// reconhecível, e transformá-lo em texto seria inventar evidência.
//
// A sentinela fica de fora porque também é uma string, mas é a forma CORRENTE
// de responder o grupo ("não informada"), não um resíduo do formato antigo.
export function readLegacyGroupText(v: unknown): string | null {
  if (typeof v !== "string") return null;
  if (v === NOT_INFORMED) return null;
  return v.trim() === "" ? null : v;
}

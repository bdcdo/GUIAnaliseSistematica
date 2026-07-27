// Sentinelas gravados no lugar de uma resposta: valores que a pesquisadora
// escolhe explicitamente para dizer que o documento não traz o dado, em
// oposição a "ainda não codifiquei".
//
// Fonte única porque a comparação é sempre por igualdade EXATA contra conteúdo
// que já está no banco — nenhum consumidor normaliza acento, caixa ou espaço
// antes de comparar. Uma cópia que derive num caractere deixa de reconhecer as
// respostas já gravadas e passa a tratá-las como valor comum, em silêncio.
// Módulo puro/client-safe (sem React) para ser importado tanto em componentes
// 'use client' quanto em server actions e testes Vitest.
export const NOT_INFORMED = "Não informada";

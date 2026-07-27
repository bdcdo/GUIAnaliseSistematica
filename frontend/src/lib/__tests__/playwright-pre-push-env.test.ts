import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  assertRequiredPrePushEnv,
  danglingEnvironmentLinks,
  requiredPrePushEnv,
} from "../../../playwright-pre-push-env";
import {
  applyEnvironment,
  readOptionalEnvironmentFile,
} from "../../../scripts/worktree-env/env-contract.mjs";

const completeRequiredEnv = Object.fromEntries(
  requiredPrePushEnv.map((name) => [name, "configured"]),
);

describe("assertRequiredPrePushEnv", () => {
  it("deriva as onze variáveis obrigatórias dos exemplos canônicos", () => {
    expect(requiredPrePushEnv).toEqual(
      [
        "NEXT_PUBLIC_SUPABASE_URL",
        "NEXT_PUBLIC_SUPABASE_ANON_KEY",
        "SUPABASE_SERVICE_ROLE_KEY",
        "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
        "CLERK_SECRET_KEY",
        "E2E_COORDINATOR_EMAIL",
        "E2E_MEMBER_EMAIL",
        "E2E_PROJECT_ID",
        "E2E_LOTTERY_PROJECT_ID",
        // coding-save.smoke.spec.ts — projeto dedicado do smoke de salvamento
        "E2E_CODING_PROJECT_ID",
        // compare-field-switch.smoke.spec.ts — projeto dedicado do smoke de
        // troca de campo na Comparação (#613)
        "E2E_COMPARE_PROJECT_ID",
      ].sort(),
    );
  });

  it("permite o pre-push sem a credencial opcional de master", () => {
    expect(() => assertRequiredPrePushEnv(completeRequiredEnv)).not.toThrow();
  });

  it("mantém variável exportada e permite override explícito do E2E", () => {
    const environment = { CLERK_SECRET_KEY: "shell" };

    applyEnvironment(environment, { CLERK_SECRET_KEY: "local" });
    expect(environment.CLERK_SECRET_KEY).toBe("shell");

    applyEnvironment(
      environment,
      { CLERK_SECRET_KEY: "e2e" },
      { override: true },
    );
    expect(environment.CLERK_SECRET_KEY).toBe("e2e");
  });

  it("tolera arquivo local ausente no modo manual", () => {
    expect(
      readOptionalEnvironmentFile(
        join(tmpdir(), "dataframeit-env-file-that-does-not-exist"),
      ),
    ).toEqual({});
  });

  it("propaga erro de leitura diferente de arquivo ausente", () => {
    expect(() => readOptionalEnvironmentFile(tmpdir())).toThrow();
  });

  it("rejeita valor obrigatório composto somente por espaços", () => {
    expect(() =>
      assertRequiredPrePushEnv({
        ...completeRequiredEnv,
        CLERK_SECRET_KEY: "   ",
      }),
    ).toThrow("Faltando: CLERK_SECRET_KEY");
  });

  it.each(requiredPrePushEnv)(
    "falha fechado quando falta a variável obrigatória %s",
    (missingName) => {
      const incompleteEnv = {
        ...completeRequiredEnv,
        [missingName]: undefined,
      };

      expect(() => assertRequiredPrePushEnv(incompleteEnv)).toThrow(
        `Faltando: ${missingName}`,
      );
    },
  );

  // Symlink de ambiente apontando para worktree removida era diagnosticado como
  // "faltando 10 variáveis" — três saltos longe da causa. A mensagem agora
  // nomeia o link e o alvo morto.
  describe("diagnóstico de symlink de ambiente pendente", () => {
    function withFixture(run: (frontend: string) => void) {
      const root = mkdtempSync(join(tmpdir(), "pre-push-env-"));
      try {
        const frontend = join(root, "frontend");
        mkdirSync(frontend, { recursive: true });
        run(frontend);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }

    it("nomeia o arquivo e o alvo inexistente na mensagem", () => {
      withFixture((frontend) => {
        const removed = join(frontend, "..", "worktree-removida", ".env.local");
        symlinkSync(removed, join(frontend, ".env.local"));

        expect(() =>
          assertRequiredPrePushEnv(
            { ...completeRequiredEnv, CLERK_SECRET_KEY: undefined },
            frontend,
          ),
        ).toThrow(/symlink de ambiente apontando para alvo inexistente/);
        expect(danglingEnvironmentLinks(frontend)).toEqual([
          { file: ".env.local", target: removed },
        ]);
      });
    });

    it("não acusa link pendente quando o alvo existe", () => {
      withFixture((frontend) => {
        const source = join(frontend, "..", "fonte");
        mkdirSync(source, { recursive: true });
        writeFileSync(join(source, ".env.local"), "X=1\n");
        symlinkSync(join(source, ".env.local"), join(frontend, ".env.local"));

        expect(danglingEnvironmentLinks(frontend)).toEqual([]);
      });
    });

    it("não acusa link pendente quando o arquivo é real", () => {
      withFixture((frontend) => {
        writeFileSync(join(frontend, ".env.local"), "X=1\n");

        expect(danglingEnvironmentLinks(frontend)).toEqual([]);
      });
    });
  });
});

"use client";

import { useActionState } from "react";
import { createProject } from "@/actions/projects";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export default function NewProjectPage() {
  const [state, formAction, pending] = useActionState(createProject, null);

  return (
    <main className="mx-auto max-w-lg p-6">
      <Card>
        <CardHeader>
          <CardTitle>Novo Projeto</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={formAction} className="space-y-4">
            {state?.error && (
              <p className="text-sm text-destructive">{state.error}</p>
            )}
            <div className="space-y-2">
              <label htmlFor="name" className="text-sm font-medium">
                Nome do projeto
              </label>
              <Input
                id="name"
                name="name"
                placeholder="Ex: Revisão sistemática — intervenções em doenças raras"
                required
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="description" className="text-sm font-medium">
                Descrição
              </label>
              <Textarea
                id="description"
                name="description"
                placeholder="Breve descrição do objetivo da revisão..."
                rows={3}
              />
            </div>
            <Button
              type="submit"
              disabled={pending}
              className="w-full bg-brand hover:bg-brand/90 text-brand-foreground"
            >
              {pending ? "Criando..." : "Criar Projeto"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}

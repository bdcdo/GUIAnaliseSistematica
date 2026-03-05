"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createBrowserClient } from "@/lib/supabase/client";
import { toast } from "sonner";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    const supabase = createBrowserClient();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });

    if (error) {
      toast.error(error.message || "Erro ao enviar link de login");
    } else {
      toast.success("Link de login enviado! Verifique seu email.");
    }
    setLoading(false);
  };

  return (
    <div className="flex min-h-screen items-center justify-center">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-lg bg-brand">
            <span className="text-lg font-bold text-brand-foreground">AS</span>
          </div>
          <CardTitle>Análise Sistemática</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleLogin} className="space-y-4">
            <Input
              type="email"
              placeholder="seu@email.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <Button type="submit" className="w-full bg-brand hover:bg-brand/90 text-brand-foreground" disabled={loading}>
              {loading ? "Enviando..." : "Entrar com Magic Link"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

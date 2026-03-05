"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addMember } from "@/actions/members";
import { toast } from "sonner";

interface AddMemberDialogProps {
  projectId: string;
}

export function AddMemberDialog({ projectId }: AddMemberDialogProps) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"coordenador" | "pesquisador">("pesquisador");
  const [loading, setLoading] = useState(false);

  const handleAdd = async () => {
    setLoading(true);
    const result = await addMember(projectId, email, role);
    if (result?.error) {
      toast.error(result.error);
    } else if (result?.invited) {
      toast.success("Convite enviado! O usuário receberá um email para acessar a plataforma.");
      setEmail("");
      setOpen(false);
    } else {
      toast.success("Membro adicionado!");
      setEmail("");
      setOpen(false);
    }
    setLoading(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="bg-brand hover:bg-brand/90 text-brand-foreground">Adicionar Membro</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Adicionar Membro</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <Input placeholder="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as "coordenador" | "pesquisador")}
            className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
          >
            <option value="pesquisador">Pesquisador</option>
            <option value="coordenador">Coordenador</option>
          </select>
          <Button onClick={handleAdd} disabled={loading || !email} className="w-full bg-brand hover:bg-brand/90 text-brand-foreground">
            {loading ? "Adicionando..." : "Adicionar"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

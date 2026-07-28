"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { guardedLinkClick } from "@/lib/unsaved-work-guard";
import { UserMenu } from "./UserMenu";

interface HeaderProps {
  projectName?: string;
  user?: { email: string; firstName?: string | null };
}

export function Header({ projectName, user }: HeaderProps) {
  const router = useRouter();
  return (
    <header className="flex h-14 items-center justify-between border-b px-4">
      <div className="flex items-center gap-3">
        {/* O logo é o terceiro canal de saída da codificação, junto das abas do
            projeto e do fechamento da janela: clicá-lo com trabalho não enviado
            passa pelo mesmo aviso (#608). Fora da codificação nenhum guard está
            registrado e o clique segue direto. */}
        <Link
          href="/dashboard"
          onClick={(event) =>
            guardedLinkClick(event, () => router.push("/dashboard"))
          }
          className="flex items-center gap-2"
        >
          <div className="flex size-8 items-center justify-center rounded-md bg-brand">
            <span className="text-sm font-bold text-brand-foreground">AC</span>
          </div>
        </Link>
        {projectName && (
          <>
            <span className="text-muted-foreground/50">/</span>
            <span className="font-medium">{projectName}</span>
          </>
        )}
      </div>
      {user && <UserMenu email={user.email} firstName={user.firstName} />}
    </header>
  );
}

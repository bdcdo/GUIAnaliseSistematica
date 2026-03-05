export default function DashboardLoading() {
  return (
    <div className="min-h-screen">
      <div className="h-14 border-b bg-background" />
      <main className="mx-auto max-w-4xl p-6">
        <div className="mb-6 flex items-center justify-between">
          <div className="h-8 w-48 animate-pulse rounded bg-muted" />
          <div className="h-10 w-28 animate-pulse rounded bg-muted" />
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-lg border p-6">
              <div className="mb-3 h-5 w-40 animate-pulse rounded bg-muted" />
              <div className="h-4 w-full animate-pulse rounded bg-muted" />
              <div className="mt-3 h-5 w-20 animate-pulse rounded-full bg-muted" />
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}

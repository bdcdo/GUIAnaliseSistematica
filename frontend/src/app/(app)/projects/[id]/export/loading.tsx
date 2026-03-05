export default function ExportLoading() {
  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="flex gap-3">
        <div className="h-10 w-36 animate-pulse rounded bg-muted" />
        <div className="h-10 w-44 animate-pulse rounded bg-muted" />
      </div>
      <div className="rounded-lg border p-6 space-y-3">
        <div className="h-5 w-48 animate-pulse rounded bg-muted" />
        <div className="h-4 w-full animate-pulse rounded bg-muted" />
        <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
        <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
      </div>
    </div>
  );
}

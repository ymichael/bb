export function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 px-6 py-12 text-center">
      <p className="max-w-md text-sm text-muted-foreground">{message}</p>
    </div>
  );
}

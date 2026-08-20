/**
 * Stand-in for every module route until that module is implemented.
 */
export function PlaceholderPage({ title }: { title: string }) {
  return (
    <section className="space-y-3">
      <h1 className="text-xl font-semibold text-slate-100">{title}</h1>
      <p className="text-sm text-slate-400">
        Not implemented yet. This route is a placeholder for the {title.toLowerCase()} module.
      </p>
    </section>
  );
}

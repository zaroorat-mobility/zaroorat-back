import { Link } from 'react-router';

export function NotFoundPage() {
  return (
    <section className="space-y-3">
      <h1 className="text-xl font-semibold text-slate-100">404</h1>
      <p className="text-sm text-slate-400">No route matches this URL.</p>
      <Link to="/" className="text-sm text-sky-400 hover:underline">
        Back to dashboard
      </Link>
    </section>
  );
}

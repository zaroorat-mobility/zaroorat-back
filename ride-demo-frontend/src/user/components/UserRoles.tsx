/** Role slugs exactly as the backend returns them. Read-only: roles are granted
 *  server-side, and authorization is not this module's concern. */
export function UserRoles({ roles }: { roles: string[] }) {
  if (roles.length === 0) {
    return <span className="text-slate-500">No roles assigned</span>;
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {roles.map((role) => (
        <span
          key={role}
          className="rounded border border-sky-900 bg-sky-950/60 px-2 py-0.5 font-mono text-xs text-sky-300"
        >
          {role}
        </span>
      ))}
    </div>
  );
}

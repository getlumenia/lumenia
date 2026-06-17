import { tr } from "../lib/copy";

export default function NotFound() {
  return (
    <main className="center">
      <p className="muted">{tr.errors.notFound}</p>
    </main>
  );
}

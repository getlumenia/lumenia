import { tr } from "../lib/copy";

/** Landing — positioning-aligned: "send money, hold dollars". No crypto words. */
export default function Home() {
  return (
    <main className="center">
      <h1 style={{ fontSize: "2.25rem", margin: 0 }}>{tr.landing.headline}</h1>
      <p className="muted" style={{ maxWidth: 420 }}>{tr.landing.sub}</p>
      <a className="btn" href="#how">{tr.landing.cta}</a>
    </main>
  );
}

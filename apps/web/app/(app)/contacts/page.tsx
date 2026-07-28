"use client";

/**
 * /contacts — the people you've paid, built entirely from YOUR OWN local history (lib/contacts),
 * never a server address book. Each row lets you pay them again (straight to their account) or ask
 * them for money. Honest empty state; nothing here leaves the browser.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useWallet } from "../../../lib/wallet";
import { loadContacts, type Contact } from "../../../lib/contacts";
import { formatUsd } from "../../../lib/money";
import { PersonChip } from "../../../components/brand/PersonChip";
import { MoneyCard } from "../../../components/brand/MoneyCard";

export default function ContactsPage() {
  const { status, account } = useWallet();
  const [contacts, setContacts] = useState<Contact[]>([]);

  useEffect(() => {
    setContacts(loadContacts());
  }, []);

  if (status === "loading") return <p className="py-10 text-center text-ink-soft">Loading…</p>;

  if (!account || contacts.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <h1 className="text-xl font-bold text-ink">No people yet</h1>
        <p className="max-w-xs text-ink-soft">
          When you pay someone&apos;s request, they show up here, so you can pay or ask them again in
          a tap.
        </p>
        <Link href="/home" className="text-sm font-semibold text-money underline-offset-2 hover:underline">
          Back home
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 py-4">
      <header>
        <h1 className="text-xl font-bold text-ink">People</h1>
        <p className="mt-1 text-sm text-ink-soft">Everyone you&apos;ve paid, kept only on this phone.</p>
      </header>

      <div className="flex flex-col gap-3">
        {contacts.map((c) => (
          <MoneyCard key={c.address} className="flex flex-col gap-3 p-4">
            <div className="flex items-center justify-between gap-3">
              <PersonChip name={c.name} />
              <p className="text-sm text-ink-soft">
                last {formatUsd(c.lastAmount)}
                {c.count > 1 ? ` · ${c.count}×` : ""}
              </p>
            </div>
            <div className="flex gap-2">
              <Link
                href={`/send?to=${encodeURIComponent(c.address)}&reqName=${encodeURIComponent(c.name)}`}
                className="flex h-10 flex-1 items-center justify-center rounded-full bg-money text-sm font-semibold text-primary-foreground"
              >
                Pay again
              </Link>
              {/* An ask link is not addressed to anyone — it goes to whoever you share it
                  with. The label says what it does, not whom it targets ("Ask" next to a
                  person implied a continuity the link doesn't carry). */}
              <Link
                href="/request"
                aria-label="Create a link that asks for money, and share it with anyone"
                className="flex h-10 flex-1 items-center justify-center rounded-full border border-line text-sm font-semibold text-ink"
              >
                Ask for money
              </Link>
            </div>
          </MoneyCard>
        ))}
      </div>
    </div>
  );
}

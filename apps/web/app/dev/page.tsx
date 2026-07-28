/**
 * /dev: scratch preview of the core-six brand components on warm paper.
 * Development-only: 404 in production (never ships to the live product).
 */
import { notFound } from "next/navigation";
import {
  AmountDisplay,
  PersonChip,
  MoneyCard,
  PrimaryButton,
  MoneyMovingAnimation,
  StatusPill,
  TestnetBanner,
} from "../../components/brand";

export default function DevPreview() {
  if (process.env.NODE_ENV === "production") notFound();

  return (
    <main className="min-h-dvh bg-background text-foreground">
      <TestnetBanner />
      <div className="mx-auto flex max-w-md flex-col gap-8 px-5 py-10">
        <header>
          <h1 className="text-2xl font-bold text-ink">Brand components</h1>
          <p className="text-ink-soft">Warm paper, serious money, Stage 1 preview.</p>
        </header>

        <section className="flex flex-col gap-3">
          <AmountDisplay value="20.00" size="xl" countUp />
          <div className="flex items-baseline gap-4">
            <AmountDisplay value="128.50" size="lg" tone="ink" />
            <AmountDisplay value="7.00" size="md" />
          </div>
        </section>

        <section className="flex flex-wrap items-center gap-4">
          <PersonChip name="Alvin" />
          <PersonChip name="Irem Koci" size="lg" joyRing />
          <PersonChip name="Meric" nameless size="sm" />
        </section>

        <MoneyCard interactive>
          <p className="text-ink-soft">A tactile envelope-soft card.</p>
          <div className="mt-3 flex items-center gap-3">
            <PersonChip name="Alvin" />
            <StatusPill status="received" />
          </div>
        </MoneyCard>

        <section className="flex flex-wrap gap-2">
          <StatusPill status="waiting" />
          <StatusPill status="received" />
          <StatusPill status="returned" />
        </section>

        <section className="flex flex-col gap-3">
          <PrimaryButton>Send your first link</PrimaryButton>
          <PrimaryButton loading loadingLabel="Moving your money…">
            Claim my money
          </PrimaryButton>
        </section>

        <MoneyCard>
          <MoneyMovingAnimation label="Moving your money to you…" />
        </MoneyCard>
      </div>
    </main>
  );
}

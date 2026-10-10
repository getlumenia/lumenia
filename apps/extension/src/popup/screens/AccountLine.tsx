/**
 * The account in use, named the way every Lumenia surface names it (LUMENIA ACCOUNT CONTRACT v1,
 * 5.3): its short address and the email it is backed up with, or what is missing, with the one
 * thing to do about it. Under the header on the home screen, and in Settings.
 */
import { accountLine, type AccountLine } from "../format";
import { useApp } from "../context";

export function AccountLineView({ onAction, center = false }: { onAction: (kind: NonNullable<AccountLine["action"]>["kind"]) => void; center?: boolean }) {
  const { ws } = useApp();
  if (!ws.account) return null;
  const line = accountLine(ws.account, ws.backup.needed);
  return (
    <p class={center ? "acct acct--center" : "acct"} title={ws.account.pubkey}>
      <span class="acct__text">{line.text}</span>
      {line.action ? (
        <button type="button" class="link link--button" onClick={() => onAction(line.action!.kind)}>
          {line.action.label}
        </button>
      ) : null}
    </p>
  );
}

"use client";

/**
 * Forwards /c/near#<secret> to /claim#<secret>. `location.replace` with the hash appended keeps the
 * fragment in the browser (it is never sent) and leaves no /c/near entry in the history, so the back
 * button does not bounce through this page. Without JavaScript nothing can read the hash, so the
 * fallback is a plain link to /claim, where the person can paste the whole link.
 */
import { useEffect } from "react";
import Link from "next/link";
import { Spinner } from "../../../components/near/primitives";
import { NEAR_CLAIM_PATH } from "../../../lib/near/config";

export function Forward() {
  useEffect(() => {
    window.location.replace(`${NEAR_CLAIM_PATH}${window.location.search}${window.location.hash}`);
  }, []);
  return (
    <div className="nc-main">
      <p className="nc-eyebrow">
        <Spinner /> Opening your link...
      </p>
      <noscript>
        <p className="nc-foot">
          This page needs JavaScript to carry your link across. <Link href={NEAR_CLAIM_PATH}>Open the claim screen</Link> and paste the
          whole link there.
        </p>
      </noscript>
    </div>
  );
}

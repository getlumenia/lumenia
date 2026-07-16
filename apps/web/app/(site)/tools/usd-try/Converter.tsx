"use client";

import { useState } from "react";
import { indicativeRate } from "../../../../lib/rate";
import { formatUsd, formatTry } from "../../../../lib/money";

export function Converter() {
  const rate = indicativeRate();
  const [usd, setUsd] = useState("100");
  const n = Number.parseFloat(usd) || 0;

  return (
    <div className="tool-panel">
      <label className="tool-field-label">
        Dollars
        <div className="tool-field">
          <span className="tool-field-sym">$</span>
          <input
            inputMode="decimal"
            value={usd}
            onChange={(e) => setUsd(e.target.value.replace(/[^0-9.]/g, ""))}
            aria-label="Dollars"
          />
        </div>
      </label>
      <div className="tool-figure">
        <span className="tool-figure-label">≈ in lira</span>
        <span className="tool-figure-value">{formatTry(n * rate)}</span>
      </div>
      <p className="tool-fine">
        Indicative rate: {formatUsd(1)} ≈ {formatTry(rate)}. Real rates move; this is for a rough idea
        only.
      </p>
    </div>
  );
}

// Simple mode's card floats (placed by the effect that follows its box); otherwise it's as is.
import type { ReactNode } from "react";
import { forwardRef } from "react";

/** Simple mode's card floats (placed by the effect that follows its box); otherwise it's as is. */
export const FloatIf = forwardRef<HTMLDivElement, { on: boolean; children: ReactNode }>(
  function FloatIf({ on, children }, ref) {
    return on ? (
      <div ref={ref} className="float-panel">
        {children}
      </div>
    ) : (
      <>{children}</>
    );
  },
);

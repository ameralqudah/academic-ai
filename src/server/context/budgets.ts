/** Context budgets by purpose, shared by the v1 builder and the Context V2 assembler. */

import type { ContextPurpose } from './envelope';

/**
 * How much room each kind of call gets.
 *
 * A routing decision needs almost nothing and is made on every message, so it
 * is cheap by design. A verification pass needs the claim and every source
 * behind it. Giving them the same budget means either the router is expensive
 * or the verifier is starved.
 */
export const BUDGETS: Record<ContextPurpose, number> = {
  route: 800,
  plan: 3000,
  execute: 4000,
  answer: 5000,
  verify: 6000,
};

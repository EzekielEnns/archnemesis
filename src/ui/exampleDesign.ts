// "Open the example": the shop as the person's own, editable design. One called Shop that is
// already there is opened as it is; otherwise it is made from the example.
import type { Backend } from "../backend/types.ts";
import { BackendError } from "../backend/types.ts";

const EXAMPLE_NAME = "Shop";

/** The design to go to, and whether this call made it. */
export async function openExample(
  backend: Pick<Backend, "designs">,
): Promise<{ key: string; created: boolean }> {
  const list = await backend.designs.list();
  const have = list.find(
    (d) => d.name.trim().toLowerCase() === EXAMPLE_NAME.toLowerCase() || d.key === "shop",
  );
  if (have) return { key: have.key, created: false };
  const made = await backend.designs.create(EXAMPLE_NAME, { example: true });
  return { key: made.key, created: true };
}

/** Plain words for why the example didn't open. */
export const exampleError = (e: unknown): string =>
  e instanceof BackendError || e instanceof Error ? e.message : "Couldn't open the example.";

/** Compact, collision-resistant-enough id for local rows. */
export function id(): string {
  return (
    Date.now().toString(36) + Math.random().toString(36).slice(2, 9)
  );
}

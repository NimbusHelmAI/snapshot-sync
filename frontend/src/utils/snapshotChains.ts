/**
 * Snapshots linked to `id` by parent links, `id` included, oldest first.
 *
 * Links run both ways, so the chain of any member is the whole connected set:
 * its ancestors, their other sons, and all their descendants. Ids are snapper
 * numbers, which increase over time, so numeric order is time order.
 */
export function chainOf(id: string, parentOf: Record<string, string | null>): string[] {
  const linked = new Map<string, Set<string>>();
  const connect = (a: string, b: string) => {
    if (!linked.has(a)) linked.set(a, new Set());
    linked.get(a)!.add(b);
  };
  for (const [child, parent] of Object.entries(parentOf)) {
    if (parent === null) continue;
    connect(child, parent);
    connect(parent, child);
  }
  const seen = new Set<string>([id]);
  const queue = [id];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of linked.get(current) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return Array.from(seen).sort((a, b) => Number(a) - Number(b));
}

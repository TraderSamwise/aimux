/**
 * How far a topology row is indented for its delegation depth.
 *
 * The project service decides the depth by walking the supervision edge once;
 * every surface only multiplies it. Shared with the TUI through
 * `testdata/contracts/v1/topology-depth/surfaces.json`, so the two cannot
 * drift into drawing different trees from the same answer.
 *
 * This row used to indent by `depth > 0`, which drew a three-level org as one
 * flat list of peers under its checkout.
 */
export const TOPOLOGY_INDENT_BASE_PX = 12;
export const TOPOLOGY_INDENT_PER_DEPTH_PX = 16;

export function topologyRowIndent(depth: number): number {
  const steps = Number.isFinite(depth) ? Math.max(0, Math.floor(depth)) : 0;
  return TOPOLOGY_INDENT_BASE_PX + steps * TOPOLOGY_INDENT_PER_DEPTH_PX;
}

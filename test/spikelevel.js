// A test-only level with spikes. The shipped arena has none (SPEC §3), but the sim keeps its
// support for the '^' tile, so its tests run on this copy of the arena: the low floor block at
// columns 12-13 becomes a spike strip on the floor (row 16), and the centre block on row 6 gets
// a strip on top of it (row 5).
import { LEVEL } from '../shared/level.js';

const grid = LEVEL.grid.slice();
grid[16] = '#...........^^...........#';
grid[5] = '#...........^^...........#';
export const SPIKE_LEVEL = Object.freeze({ ...LEVEL, grid: Object.freeze(grid) });

// The site around the observer: where the eye is and where the CHORD dishes
// stand.  The "site frame" is metres east and north of the site's position
// (site.json site.lat, lon); everything the page draws is in metres east
// and north of the eye (toEye).
//
// Sources: the block house's outline is OpenStreetMap's (way 1188868675,
// ODbL).  The array's place is from the observatory's site plan, set
// against OpenStreetMap's outline of the main laboratory (to about 10 m);
// the dishes of the full array are read off the CHORD layout figure, both
// given by the user (2026-11-25).  The array is aligned north-south; the
// figure's tilt of about 1 degree is not real.

/** The eye above the ground (m): on the block house's roof, at the height
 *  of its weather mast. */
export const EYE_M = 10;

/** The eye, over the middle of the block house, in the site frame. */
export const EYE_AT = [-87.9, 160.7];

/** Site frame (m) to metres east and north of the eye. */
export const toEye = ([e, n]) => [e - EYE_AT[0], n - EYE_AT[1]];

/** The buildings: their middle east and north of the eye, half sizes
 *  (m) east and north, and height (m).  Outlines from OpenStreetMap. */
export const BUILDINGS = [
  { name: "block house", at: toEye([-87.9, 160.75]), half: [6.2, 6.25], h: 3.6 },   // OSM way 1188868675; one storey
];

/** The full array's south-west dish, in the site frame.  Dish (i, j) stands
 *  i grid steps east and j north of it (site.json array dx_m, dy_m). */
export const SW_AT = [-131, -93];

/** The full array: for each row from the south, its dishes' columns (runs
 *  from the west).  The two gaps (rows 6 and 17) hold small containers. */
export const FULL_ROWS = ["0-19", "0-19", "0-19", "0-19", "0-19", "0-19", "0-9 11-20", "0-21", "0-21", "0-21",
  "0-21", "0-21", "0-21", "0-21", "0-21", "0-21", "0-21", "0-9 11-21", "0-21", "0-21", "0-21", "0-21", "0-21", "1-21"];

/** The pathfinder: the full array's south-west corner, nx x ny dishes. */
const inPathfinder = (i, j, array) => i < array.nx && j < array.ny;

/** The dishes: { at: [east, north] of the eye (m), pathfinder: bool }, the
 *  pathfinder's alone or the full array's. */
export function dishes(array, full) {
  const out = [];
  FULL_ROWS.forEach((row, j) => {
    for (const run of row.split(" ")) {
      const [a, b] = run.split("-").map(Number);
      for (let i = a; i <= b; i++) {
        const pathfinder = inPathfinder(i, j, array);
        if (pathfinder || full) out.push({ at: toEye([SW_AT[0] + i * array.dx_m, SW_AT[1] + j * array.dy_m]), pathfinder });
      }
    }
  });
  return out;
}

/** The pathfinder's centre, east and north of the eye (m). */
export const arrayAt = (array) =>
  toEye([SW_AT[0] + ((array.nx - 1) / 2) * array.dx_m, SW_AT[1] + ((array.ny - 1) / 2) * array.dy_m]);

/** The ground kept level and clear of trees and boulders: the site's
 *  buildings and both arrays, centre east and north of the eye and half
 *  sizes (m). */
export const SITE_BOX = (() => {
  const lo = toEye([-270, -125]), hi = toEye([135, 240]);
  return [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2];
})();

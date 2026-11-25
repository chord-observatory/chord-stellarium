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

/** The eye, 2 m south of the block house's south wall (so its roof does
 *  not fill the view south, and the eye is not over it), in the site
 *  frame. */
export const EYE_AT = [-87.9, 152.5];

/** Site frame (m) to metres east and north of the eye. */
export const toEye = ([e, n]) => [e - EYE_AT[0], n - EYE_AT[1]];

/** The buildings on the site: outlines (site frame, counter-clockwise),
 *  flat roofs at h (m); wall: their colour (else pale concrete); windows:
 *  rows of them.  Outlines from OpenStreetMap and Microsoft's building
 *  footprints (both ODbL).  The main laboratory (OSM 133442186: two tall
 *  storeys, tan panels) and the orange two-storey block beside it (taken
 *  to be OSM 1188868679) follow the user's photograph; the other heights
 *  are guesses (one storey, 3 to 4 m), save the block house's (user). */
export const BUILDINGS = [
  { src: "OSM way 133442183", h: 3.0, pts: [[16.4,-26.9],[25.2,-26.9],[25.2,-17.3],[16.4,-17.3]] },
  { src: "OSM way 133442186", h: 8.5, wall: [0.66, 0.56, 0.42], windows: true, pts: [[44.3,92.8],[44.3,70.9],[45.4,70.9],[45.4,69.1],[39.5,69.1],[39.5,56.2],[37.8,56.2],[37.8,53.1],[39.6,53.1],[39.6,52.9],[40.4,52.9],[40.4,46.8],[52.0,46.8],[52.0,56.0],[55.9,56.0],[55.9,59.4],[52.0,59.4],[52.0,69.1],[49.7,69.1],[49.7,70.9],[53.2,70.9],[53.2,68.4],[59.3,68.4],[59.3,69.8],[96.2,69.8],[96.2,71.1],[101.4,71.1],[101.4,92.8]] },
  { src: "OSM way 1188868674", h: 3.0, pts: [[-89.8,168.8],[-82.7,168.8],[-82.7,174.6],[-89.8,174.6]] },
  { src: "OSM way 1188868675", h: 3.6, pts: [[-94.1,154.5],[-81.7,154.5],[-81.7,167.0],[-94.1,167.0]] },
  { src: "OSM way 1188868677", h: 2.6, pts: [[20.3,-42.9],[24.4,-42.9],[24.4,-38.0],[20.3,-38.0]] },
  { src: "OSM way 1188868678", h: 4.0, pts: [[63.2,12.0],[72.4,12.0],[72.4,28.9],[66.1,28.9],[66.1,31.6],[81.2,31.6],[81.2,39.1],[63.2,39.1]] },
  { src: "OSM way 1188868679", h: 7, wall: [0.72, 0.5, 0.33], windows: true, pts: [[62.6,52.4],[62.6,48.3],[63.7,48.3],[63.7,45.9],[81.7,45.9],[81.7,54.0],[63.7,54.0],[63.7,52.4]] },
  { src: "OSM way 1188868680", h: 2.6, pts: [[70.5,129.5],[75.2,129.5],[75.2,134.2],[70.5,134.2]] },
  { src: "OSM way 1188868681", h: 3.0, pts: [[77.1,148.8],[84.5,148.8],[84.5,156.9],[77.1,156.9]] },
  { src: "OSM way 1188868682", h: 3.5, pts: [[60.2,158.5],[75.2,158.5],[75.2,170.1],[60.2,170.1]] },
  { src: "OSM way 1188868683", h: 3.0, pts: [[31.1,166.5],[38.7,166.5],[38.7,174.0],[31.1,174.0]] },
  { src: "OSM way 1188868684", h: 3.5, pts: [[14.3,146.0],[24.2,146.0],[24.2,158.4],[14.3,158.4]] },
  { src: "Microsoft footprint", h: 3.0, pts: [[59.9,220.1],[51.0,220.1],[51.0,212.6],[59.9,212.6]] },
  { src: "Microsoft footprint", h: 2.6, pts: [[80.9,217.5],[80.8,212.3],[85.9,212.1],[86.1,217.3]] },
];

/** Shipping containers (white, 2.6 m high): middle (site frame), half
 *  sizes east and north (m).  CHIME's beside its cylinders, from the
 *  user's site plan; the two in the full array's gaps (full: only with it),
 *  which hold compute (user). */
export const CONTAINERS = [
  { at: [-157.7, 9.0], half: [1.6, 3.9] }, { at: [-157.7, -8.8], half: [1.6, 6.9] },
  { at: [-152.5, 3.6], half: [1.7, 3.6] }, { at: [-152.5, -8.2], half: [1.7, 6.3] },
  { at: [-204.8, 67.8], half: [1.7, 3.7] }, { at: [-201.3, 67.8], half: [1.4, 3.7] },
  { at: [-68.0, -42.0], half: [3.03, 1.22], full: true }, { at: [-68.0, 51.5], half: [3.03, 1.22], full: true },
];

/** CHIME: four cylinders, 20 m across and 100 m long, their axes north-
 *  south, focal lines 22 m apart (site frame), from the user's site plan;
 *  f = 5 m. */
export const CHIME = { at: [[-234.3, -0.4], [-212.5, -0.4], [-190.6, -0.4], [-168.8, -0.4]], half: [10, 50], f: 5 };

/** The John A. Galt 26 m dish: its pedestal's middle (site frame), from
 *  OpenStreetMap (node; the site plan agrees to 2 m).  Drawn stowed at
 *  the zenith (user: any pose). */
export const GALT = { at: [46.1, 16.9], D: 26 };

/** Lawn (site frame): the watered grass west of the laboratory (the
 *  user's photograph and site plan). */
export const LAWN = [[[15.5, 50], [37.5, 50], [37.5, 101], [15.5, 101]]];

/** Paved ground (site frame): the laboratory's car park and the Galt
 *  dish's pad (asphalt), from the user's site plan; the drive east of
 *  the buildings. */
export const PAVED = [
  [[13.8, 103.6], [62.6, 103.6], [62.6, 128.2], [13.8, 128.2]],
  [[29.4, 2.0], [60.7, 2.0], [60.7, 27.4], [29.4, 27.4]],
  [[88.0, 25.4], [93.9, 19.6], [111.4, 35.2], [111.4, 136.8], [101.7, 136.8], [101.7, 39.1]],
];

/** Roads: centre lines (site frame) and width (m).  The site's service
 *  road, OpenStreetMap way 35890350 (asphalt), to the edge of the level
 *  ground (SITE_BOX). */
export const ROADS = [
  { width: 5, pts: [[54.9, 14.6], [44.7, 8.9], [35.1, 11.3], [35.1, 50.5], [27.8, 55.6], [19.9, 61.4], [15.6, 66.0], [12.9, 72.1], [11.7, 79.6],
    [12.0, 122.7], [7.4, 128.0], [-1.4, 130.0], [-67.5, 129.0], [-82.5, 128.4], [-100.3, 123.4], [-126.2, 114.2], [-141.9, 109.7], [-156.7, 106.9], [-266, 86]] },
];

/** All of the above east and north of the eye, for models.js: the
 *  containers of the full array only when full. */
export function siteModels(full) {
  const pts = (p) => p.map(toEye);
  return {
    buildings: BUILDINGS.map((b) => ({ h: b.h, pts: pts(b.pts), wall: b.wall, windows: b.windows })),
    containers: CONTAINERS.filter((c) => full || !c.full).map((c) => ({ at: toEye(c.at), half: c.half })),
    paved: PAVED.map(pts),
    lawn: LAWN.map(pts),
    roads: ROADS.map((r) => ({ width: r.width, pts: pts(r.pts) })),
    chime: { ...CHIME, at: CHIME.at.map(toEye) },
    galt: { ...GALT, at: toEye(GALT.at) },
  };
}

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

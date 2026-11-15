// Screenshots of the observatory page in headless Chrome, with the page's
// console errors.  For checking a change without a browser at hand.
//
//   node shots.mjs <base url> <out dir> <width>x<height> <name>=<fragment> ...
//   e.g. node shots.mjs http://127.0.0.1:8765/ /tmp/shots 1400x900 \
//          dome='t=2026-10-30T10:59:20Z' chart='t=2026-10-30T10:59:20Z&v=chart'
//
// Needs puppeteer (npm install puppeteer in a scratch directory; cx69 has
// the libraries Chrome needs).  WebGL runs on SwiftShader.

import puppeteer from "puppeteer";

const [base, outDir, size, ...jobs] = process.argv.slice(2);
const [width, height] = size.split("x").map(Number);
const browser = await puppeteer.launch({
  headless: true,
  args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
let errors = 0;
for (const job of jobs) {
  const i = job.indexOf("=");
  const name = job.slice(0, i), frag = job.slice(i + 1);
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") { errors++; console.log(`${name} console ${m.type()}: ${m.text()}`); } });
  page.on("pageerror", (e) => { errors++; console.log(`${name} page error: ${e.message}`); });
  await page.goto(`${base}#${frag}`, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 2500));
  await page.screenshot({ path: `${outDir}/${name}.png` });
  console.log(`${name}: ${outDir}/${name}.png`);
  await page.close();
}
await browser.close();
process.exit(errors ? 1 : 0);

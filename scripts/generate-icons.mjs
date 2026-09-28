// Regenerates every icon from the Foldrule mark:  node scripts/generate-icons.mjs
//   app/icon.svg          – favicon (modern browsers)
//   app/favicon.ico       – 16/32/48 px favicon (legacy browsers)
//   app/apple-icon.png    – 180 px iOS home-screen icon
//   public/icons/*.png    – PWA icons (192, 512, maskable 512)
//   public/brand/*.svg    – mark artwork for print / docs
import sharp from 'sharp';
import { writeFileSync, mkdirSync } from 'node:fs';

const C = { graphite: '#1D2125', rule: '#F2C230', paper: '#E6E9EC' };
const TICKS = [[30,19,30,14.5],[38,19,38,14.5],[46,19,46,14.5],[34,19,34,16.5],[42,19,42,16.5],
  [30,41,30,36.5],[38,41,38,36.5],[34,41,34,38.5],[23,47,18.5,47],[23,51.5,20.5,51.5]];

function markInner(tone, ticks) {
  const seg = tone === 'dark' ? C.rule : C.graphite;
  const tick = tone === 'dark' ? C.graphite : C.paper;
  const hinge = tone === 'dark' ? C.graphite : C.rule;
  const t = ticks ? `<g stroke="${tick}" stroke-width="1.4">${TICKS.map(([a,b,c,d]) => `<line x1="${a}" y1="${b}" x2="${c}" y2="${d}"/>`).join('')}</g>` : '';
  return `<rect x="12" y="8" width="11" height="48" rx="2" fill="${seg}"/><rect x="12" y="8" width="42" height="11" rx="2" fill="${seg}"/><rect x="12" y="30" width="31" height="11" rx="2" fill="${seg}"/>${t}<circle cx="17.5" cy="13.5" r="2.4" fill="${hinge}"/><circle cx="17.5" cy="35.5" r="2.4" fill="${hinge}"/>`;
}

/** Rounded graphite tile with the yellow mark. scale = mark size relative to tile. */
function tile({ ticks = true, radius = 14, scale = 0.78, bleed = false } = {}) {
  const s = 64 * scale, o = (64 - s) / 2;
  const bg = bleed ? `<rect width="64" height="64" fill="${C.graphite}"/>` : `<rect width="64" height="64" rx="${radius}" fill="${C.graphite}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${bg}<g transform="translate(${o} ${o}) scale(${scale})">${markInner('dark', ticks)}</g></svg>`;
}
const bare = (tone) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${markInner(tone, true)}</svg>`;

const png = (svg, size) => sharp(Buffer.from(svg), { density: 72 * (size / 64) * 4 }).resize(size, size).png().toBuffer();

function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  const entries = []; let offset = 6 + 16 * images.length;
  for (const { size, data } of images) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2); e.writeUInt8(0, 3); e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8); e.writeUInt32LE(offset, 12);
    offset += data.length; entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...images.map(i => i.data)]);
}

mkdirSync('public/icons', { recursive: true });
mkdirSync('public/brand', { recursive: true });

writeFileSync('app/icon.svg', tile({ ticks: false }));
writeFileSync('app/favicon.ico', ico(await Promise.all([16, 32, 48].map(async size => ({ size, data: await png(tile({ ticks: size >= 48 }), size) })))));
writeFileSync('app/apple-icon.png', await png(tile({ bleed: true, scale: 0.72 }), 180));
writeFileSync('public/icons/icon-192.png', await png(tile(), 192));
writeFileSync('public/icons/icon-512.png', await png(tile(), 512));
writeFileSync('public/icons/maskable-512.png', await png(tile({ bleed: true, scale: 0.6 }), 512));
writeFileSync('public/brand/foldrule-mark-on-dark.svg', bare('dark'));
writeFileSync('public/brand/foldrule-mark-on-light.svg', bare('light'));
writeFileSync('public/brand/foldrule-app-icon.svg', tile());
console.log('Icons written.');

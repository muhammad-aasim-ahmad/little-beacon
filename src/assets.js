// Loads balance data, the atlas manifest and every required PNG (paths relative to this module).
const url = (p) => new URL(`../${p}`, import.meta.url).href;

async function json(p) {
  const r = await fetch(url(p), { cache: 'no-cache' });
  if (!r.ok) throw new Error(`Could not load ${p} (${r.status})`);
  return r.json();
}

function image(p) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not load ${p}`));
    img.src = url(p);
  });
}

export async function loadAssets() {
  const [balance, manifest] = await Promise.all([json('data/balance.json'), json('data/atlas_manifest.json')]);
  if (!balance.depths || balance.depths.length !== 4 || !manifest.atlases) throw new Error('Game data is malformed');
  const names = Object.keys(manifest.atlases);
  const imgs = await Promise.all([...names.map((n) => image(manifest.atlases[n].image)), image(manifest.background)]);
  const atlases = {};
  names.forEach((n, i) => { atlases[n] = { ...manifest.atlases[n], img: imgs[i] }; });
  return { balance, manifest, atlases, background: imgs[imgs.length - 1], iconsUrl: url(manifest.atlases.icons.image) };
}

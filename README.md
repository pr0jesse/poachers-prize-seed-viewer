# Poacher's Prize: paintkit hat viewer

A static page: one hat on a dummy head and a **Randomize** button. Drag to turn the hat, Ctrl + left drag to move the light, scroll or Ctrl + right drag to zoom (a little). On touch: one finger turns, two fingers pinch to zoom and slide to move the light. No build step and no server code.

## Put it on GitHub Pages

1. Create a repo and upload everything in this folder (keep the folder structure).
2. Settings, Pages, Source: "Deploy from a branch", branch `main`, folder `/ (root)`.
3. The page appears at `https://<your name>.github.io/<repo>/`.

To try it on your own PC first, double click `start.bat` (needs Node.js, nothing else is downloaded). It starts a small local server and opens the page. Opening `index.html` by double clicking will not work: browsers refuse to load the files that way. `start.bat` and `server.js` are only for local testing, GitHub Pages does not need them.

## What is in the folder

| File | What it is |
|---|---|
| `index.html`, `style.css` | The page and its war paint style look. The item name is the `<h1>` in `index.html`. |
| `main.js` | The roll, the shading, the controls. Settings are at the top. |
| `assets/hat_head.glb` | Your hat (`hat`) and the dummy head (`head`) |
| `assets/patterns/` | fur_a, fur_b, fur_gradient, blotch, marks (2048), static_uv as PNG (converted from your VTFs, full size). The roll itself draws at 512, like the game |
| `assets/hat/` | The hat's colour (fallback), normal and phong exponent textures as PNG |
| `assets/head/` | The mannequin's textures, shrunk from 4096 to 512 |
| `assets/font/` | Anton, the title font (SIL Open Font License) |
| `lib/` | Three.js (MIT licence), so the page needs no outside links |

## How the roll works

Pressing Randomize picks a random whole number and draws the hat's full texture on the graphics card in one pass, then shows it. It is not a cached picture. The number is only in the address bar (`#seed=...`), so a link such as `.../#seed=1234` opens that exact hat.

The seed rules are the ones from your Workbench compositor: each layer's rotation, scale and translate come from the seed, the layer's place in the definition and the field name, using the same hash. The definition itself is written out in `LOOKUPS` at the top of `main.js`. If you change the paintkit definition, `LOOKUPS` has to change with it (send it to me and I will).

**These seeds are not the game's seeds.** Valve's compositor is not public, so the Workbench's rules (how a layer is wrapped, how the blend works) are assumptions. Your hat has no paintkit in the game yet, so there is nothing to match.

To check this page against your Workbench: type the same whole number as the seed there, then open `index.html#seed=<same number>` here and compare. Try three or four seeds.

## Shading

The hat uses your VMT values: phong boost 2.75, fresnel 0.1 / 0.4 / 1, phong albedo tint on (the mask is the green channel of the exponent texture), rim exponent 4, rim boost 25 with the rim mask from the exponent texture's alpha, and the normal map's alpha as the phong mask. The head uses the mannequin's own VMT values.

What is a guess:
- **The light ramp.** `models/player/pyro/pyro_lightwarp` is a Valve texture and was not in the files. The page uses a drawn stand in. To use the real one, convert it to `assets/lightwarp.png` (256 x 1) and set `USE_LIGHTWARP_FILE = true` in `main.js`.
- **The light rig** (colour, ambient, where the light starts) and the rim light formula. Compare with a screenshot from the game and adjust the numbers at the top of `main.js`.

## Licences to check before publishing

- Three.js: MIT (`lib/THREE-LICENSE`).
- Anton font: SIL Open Font License 1.1 (`assets/font/ANTON-LICENSE.txt`).
- The mannequin's textures (`assets/head/`) come from the ODD mannequin pack, which is not yours. Get the author's permission, or use a plain grey head: set `PLAIN_HEAD` to `true` in `main.js` and delete the `assets/head` folder.
- TF2 itself, its name and its art belong to Valve. The TF2 fonts (`assets/font/tf2*.ttf`) and the hat's textures are Valve related, so check that you are happy to publish them.

## Checks run

- The graphics card roll matches an independent CPU calculation of the same layers to within rounding (largest difference 0.55 out of 255) on five seeds.
- The page fits without scrolling at nine screen sizes from 320 x 568 up to 2560 x 1080, in upright and sideways phone shapes.

## Tail jiggle

`assets/jiggle.json` holds the skin weights for the hat's tail (from `random_seed_test.smd`, matched to the hat in `hat_head.glb` by UV) and the two bone points. The springs use the QC's jigglebone values (stiffness 100, damping 7). The tail always jiggles. If you replace `hat_head.glb` with a different hat mesh, the vertex count no longer matches and the page falls back to a stiff hat.

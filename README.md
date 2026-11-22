# Poacher's Prize: paintkit hat viewer

A static page: one hat on a dummy head and a **Randomize** button. Drag to turn the hat, Ctrl + left drag to move the light, scroll or Ctrl + right drag to zoom (a little). On touch: one finger turns, two fingers pinch to zoom and slide to move the light. No build step and no server code.

Workshop page: https://steamcommunity.com/sharedfiles/filedetails/?id=3844173236

## How the roll works

Pressing Randomize picks a random whole number and draws the hat's full texture on the graphics card in one pass, then shows it. It is not a cached picture. The number is only in the address bar (`#seed=...`), so a link such as `.../#seed=1234` opens that exact hat.

The seed rules are the ones from your Workbench compositor: each layer's rotation, scale and translate come from the seed, the layer's place in the definition and the field name, using the same hash. The definition itself is written out in `LOOKUPS` at the top of `main.js`. If you change the paintkit definition, `LOOKUPS` has to change with it (send it to me and I will).

**These seeds are not the game's seeds.** Valve's compositor is not public, so the Workbench's rules (how a layer is wrapped, how the blend works) are assumptions. Your hat has no paintkit in the game yet, so there is nothing to match.

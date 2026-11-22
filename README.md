# Poacher's Prize: paintkit hat viewer

A static page that shows the Poacher's Prize hat on a dummy head, with a **Randomize** button that gives it a new random paintkit pattern.

Workshop page: https://steamcommunity.com/sharedfiles/filedetails/?id=3844173236

## Controls

- Mouse: drag to turn the hat, Ctrl + left drag to move the light, scroll or Ctrl + right drag to zoom (a little).
- Touch: one finger turns, two fingers pinch to zoom and slide to move the light.

## How it works

Pressing Randomize picks a random whole number (the seed) and draws the hat's full texture on the graphics card in one pass, then shows it. The seed is only in the address bar (`#seed=...`), so a link such as `.../#seed=1234` opens that exact hat.

The hat's fur comes from the paintkit's textures (fur A, fur B, gradient, blotch, marks and static UV). Each layer's rotation, scale and offset is worked out from the seed, in a similar way to the TF2 Workbench.

**These are not Valve's seeds.** Valve's own compositor is not public, so this page recreates the idea. The same seed number will not give the same hat as in the game or the Workbench.

The tail has a small spring simulation, so it swings when you turn the hat. The shading imitates TF2's look (light ramp, phong, rim light).

## Running it locally

There is no build step. Browsers block loading files from disk, so serve the folder rather than opening `index.html` directly: run `start.bat` on Windows (needs Node.js), or use any static file server.

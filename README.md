# Illuminate

A playground for light and matter. Paint with light, place screens and glass, open walls to the sky, and watch one room answer in real time. The lighting is global illumination computed with a world-space implementation of Alexander Sannikov's *Radiance Cascades*, running in WebGPU compute shaders.

**Live:** https://sushilgr.github.io/illuminate/

It opens on a daylit loft: three floor-to-ceiling windows, a warm ribbon cupped by a curved screen, a fluted glass slab standing in the sun, a ceramic panel on the far wall. Everything moves slowly on a 40 second loop, and everything can be moved, repainted or removed.

## Run it

Needs Node 22 or newer and a browser with WebGPU (current Chrome or Edge; Safari 26). There is no WebGL fallback: the solver is compute-only, and the page says so if WebGPU is missing.

```sh
npm ci
npm run dev        # http://127.0.0.1:5173
npm run build      # type-check, then build into dist/
npm run preview    # serve dist/
```

Pinned versions: three 0.187.0 (WebGPURenderer and TSL), Vite 8.3.7, TypeScript 7.0.2. Pushing to `main` builds and publishes to GitHub Pages through `.github/workflows/deploy.yml`.

## Using it

The viewport fills the window. Tools are on the left rail, the inspector for whatever is selected on the right, the timeline along the bottom when you ask for it.

| Key | |
| --- | --- |
| `V` | Select. Drag an object across the floor; `Shift` lifts it, `Ctrl` snaps, `Alt`-drag duplicates |
| `G` `R` `S` | Move, rotate, scale the selection by dragging |
| `N` | Navigate. In every other tool, right-drag orbits, middle-drag pans, wheel zooms |
| `B` | Paint light: ribbons or tubes, on surfaces or on a level construction plane. Pen pressure sets width. `[` `]` change the brush width |
| `E` | Erase an object |
| `F` | Etch: rub the frost off a frosted glass slab (`Alt` puts it back) |
| `M` | Light meter: illuminance in lux under the pointer |
| `A` | Add an object, a light, glass, a window or a skylight |
| `U` | Understand the light: a draggable line with direct light on one side and the full solution on the other |
| `Space` `T` | Play or pause the clock; show the timeline and the motions of the selection |
| `I` `P` | Inspector; presentation mode (`Esc` returns) |
| `Ctrl/Cmd+Z`, `Shift+Ctrl/Cmd+Z`, `Ctrl/Cmd+D`, `Delete` | Undo, redo, duplicate, remove |

Things worth trying:

- **Shadow loom.** Load *Morning Aperture*: louvers turn in front of low sun and comb the room with moving stripes. Select the louvers, open the timeline, and change the motion's amount or period.
- **Frost etching.** Load *Frost Garden*, press `F` and draw on the frosted panel. Where the frost is gone the sun passes cleanly and writes the same strokes on the floor.
- **Light score.** Select any light, add *Breathe* motions with different periods to several of them, and scrub the loop. In Paint, switch on *As motion* and draw a path: the selected object follows it for the rest of the loop.
- Close a window (select it, raise *Shutter*), switch a light off, or push the ceramic panel towards a white wall with `U` on.

Scenes: *Atelier* (the opening scene), *Morning Aperture*, *Amber Study*, *Frost Garden*, *Chromatic Fold*. The camera button on the rail saves a still (at screen size or twice that), records one loop as video, and exports or imports the scene as a versioned JSON file. The working scene is kept in local storage; `?fresh` in the URL ignores it.

Units are physical throughout: metres, luminance in kcd/m², illuminance in klx (the meter reads lux), luminous flux in klm, colour temperature in kelvin, exposure in stops. A clear midday sun is about 100 klx; the inspector's daylight multipliers are relative to that.

## Performance

Measured on an Apple-silicon MacBook Pro (12 CPU cores, Metal 3, 1728 x 1117 display at 2x), Chromium 152, opening scene in motion, drawing buffer 1932 x 1086:

| Lighting tier | GPU compute per frame | of which final gather | Solver memory | Rays per frame |
| --- | --- | --- | --- | --- |
| Low | 11.9 ms | 7.7 ms | 35 MB | 0.8 M |
| Medium (default) | 14.4 ms | 8.0 ms | 51 MB | 1.8 M |
| High | 28.3 ms | 8.0 ms | 172 MB | 6.4 M |

CPU time inside a frame is about 2 ms; the JavaScript heap stays near 210 MB.

How to read this: these are GPU timestamp queries taken while the page ran in a browser pane that was not on screen, stepped frame by frame. In that state the GPU clocks down: the same method read 10.5 to 13.7 ms for the earlier lighting-only prototype, which ran at about 100 frames per second in a foreground Chrome window on the same machine. So the medium tier should clear 60 fps at 1080p here with room to spare, and the high tier should not. A display-synchronised frame rate for the finished application has **not** been measured; the number to trust is the one in the top bar of the running page.

The frame loop adapts. With lighting set to *Adaptive*, about two seconds of frames slower than 21 ms first lower the render resolution in steps (to 72 % at most), then drop a lighting tier; ten seconds of frames faster than 13.5 ms win the resolution back. The gap between the two thresholds is the hysteresis. Rendering stops while the tab is hidden, nothing is read back from the GPU inside a frame, and a lost device shows a notice rather than a frozen picture.

## How it works

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) is the full account: the cascade hierarchy and merge, how bounces are defined, where glass, caustics and haze connect to the solver, measured accuracy against brute-force references, the verification results, and what is known to be wrong.

The short version of the limitations: lighting detail is bounded by a 5 cm voxel grid at the default tier (3.5 cm at High), so geometry thinner than about one and a half voxels can leak or vanish; near-field irradiance under small emitters is 20 to 25 % too strong; glass refraction of the view is a screen-space approximation; caustics come from the sun only; there is no depth of field and no progressive reference mode.

## URL parameters

`preset=morning-aperture|amber-study|frost-garden|chromatic-fold`, `q=low|medium|high`, `mp=<megapixels>` (pixel budget, default 2.1), `fresh` (ignore the saved scene), `paused`, `time=<seconds>`, `scene=area|umbra|ribbon|enclosure` (validation scenes; then `__illuminate.validate()` in the console).

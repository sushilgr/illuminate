# Illuminate

A playground for light and matter: an interactive browser experiment in painting and sculpting light, with real-time global illumination based on Alexander Sannikov's *Radiance Cascades*.

**Status: lighting-core prototype.** This stage establishes the world-space Radiance Cascades solver with one thin emitter, blockers and a coloured bounce surface. The interface, painting tools, glass optics and motion system build on it.

Live build: https://sushilgr.github.io/illuminate/

## Run

Requires Node 22+ and a browser with WebGPU (current Chrome, Edge or Safari).

```sh
npm ci
npm run dev      # http://127.0.0.1:5173
npm run build    # type-check and build into dist/
```

Pinned toolchain: three 0.187.0 (WebGPURenderer, TSL), Vite 8.3.7, TypeScript 7.0.2.

## Prototype controls

| Key | Action |
| --- | --- |
| drag / wheel | orbit and zoom |
| `0`-`8` | final image and diagnostic views |
| `b` | toggle indirect bounces |
| `e` | switch the ribbon on and off |
| `i` | one or two solver iterations per frame |
| `space` | pause the scene clock |
| `-` `=` | exposure |
| `h` | hide the readout |

URL parameters: `q=low|medium|high` (GI sampling density, default `medium`), `mp` (pixel budget in megapixels, default 2.1), `rs` (render scale), `iter` (solver iterations per frame), `scene=area|umbra|ribbon|enclosure` (validation scenes).

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the solver, its measured accuracy and its limitations.

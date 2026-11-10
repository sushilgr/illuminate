# Rendering architecture

What is implemented, what was measured, and what is known to be wrong. Numbers were taken on an Apple-silicon MacBook Pro (Metal 3) in Chromium 152 unless stated otherwise.

## Layout of the code

| | |
| --- | --- |
| `src/scene` | The scene document (`types.ts`), undo history, object library, presets, motion evaluation, the daylight model, meshes for the raster passes, and the packer that turns the document into solver primitives |
| `src/gi` | The solver: WGSL compute kernels and `GISystem`, which owns every GPU resource they use |
| `src/render` | `Renderer` (frame graph and the display transform) and `optics.ts` (glass materials) |
| `src/edit` | Pointer tools and viewport overlays |
| `src/ui` | The interface. Nothing in it runs inside the frame loop except throttled readouts |
| `src/app/App.ts` | Owns the renderer, the solver, the document and the scene clock; adaptive quality; capture |

One scene description drives everything. Each frame the runtime evaluates the motions at the current loop phase, updates the meshes, and re-packs the solver's primitive list only if the packed bytes changed.

## Frame

1. **Voxelise** (only when the packed scene changed). Analytic primitives (room shell with carved openings, rounded boxes, cylinders, spheres, arc walls, arches, slats, perforated panels, lenses, prisms) are evaluated into 3D textures: signed distance to solids, signed distance to glass, diffuse reflectance, emitted radiance, and glass transmittance and frost. Painted strokes are not solids: they are splatted as a prefiltered emission density with an anisotropy tensor and a mip chain.
2. **Glow.** Frosted glass sheets in a direct beam re-emit the scattered share as a volumetric emission density.
3. **Radiance cache.** Every surface voxel gets its outgoing radiance: `L = Le + albedo / pi * (E_gather + E_direct)`. `E_direct` is the analytic sun and the light apertures (spots), shadowed through the distance field. `E_gather` is read from the cascades of the previous solve.
4. **Cascades**, top-down. Each cascade traces its radiance interval for every probe direction and merges with the cascade above.
5. **G-buffer.** three.js `WebGPURenderer` rasterises meshes generated from the same parameters into base colour, world normal and roughness, emitted radiance and metalness, and depth (TSL node materials, MRT). Glass is rasterised into a second, small G-buffer.
6. **Caustics.** Sun photons are traced through glass in light space and splatted to the screen.
7. **Deferred lighting** (compute): the final gather, analytic direct light, caustics, a specular cone for smooth surfaces, haze. Then the glass layer's reflection and frost scatter.
8. **Glass composite** (forward, TSL): refraction of the lit image.
9. **Display transform**, once: white balance, exposure, bloom, tone curve with adjustable highlight rolloff, saturation, contrast, FXAA, vignette, grain. Editor overlays (selection frame, brush cursor, construction plane) are drawn into their own target and laid over the finished picture here, so they never touch the lighting and are absent from captures.

Lighting is linear HDR in photometric units until step 9. The solver's textures, buffers and bind groups are created by `GISystem` on the renderer's own `GPUDevice` and are never touched by three.js; the only shared resources are the G-buffer attachments. Nothing is read back inside a frame: GPU timings, the light meter and capture use asynchronous buffer maps.

## Radiance cascades

World-space, dense probe grids. At the default (medium) tier the voxel is 5.25 cm and the domain is 128 x 72 x 108 voxels, enclosing the 6.16 x 3.3 x 5.04 m room and its walls.

| | Probe spacing | Directions traced | Directions stored | Interval |
| --- | --- | --- | --- | --- |
| cascade 0 | 4 voxels | 8 x 8 | 8 x 8 | 1 to 2 spacings |
| cascade 1 | 8 voxels | 16 x 16 | 8 x 8 | x 4 |
| cascade 2 | 16 voxels | 32 x 32 | 16 x 16 | x 4 (medium: to infinity) |
| cascade 3 | 32 voxels | 64 x 64 | 32 x 32 | to infinity (high only) |

- Probe spacing doubles and the direction count quadruples per level, as in the paper. The interval length grows by 4 rather than 2, which keeps the spatial and the angular error of each level equal. With a factor of 2.5, a floor under a blocker hung halfway below an emitter still received 56 % of the unoccluded light.
- Directions use an equal-area square-to-sphere map, so the 2 x 2 children of a direction tile are exactly its four refined directions. Cascades above 0 store the average of each 2 x 2 group, which is what the level below reads.
- Rays are cones marched through the distance field. A surface crossed by the axis stops the ray; surfaces beside it contribute fractional coverage; painted strokes and glowing frost add their prefiltered emission; glass tints the ray (Beer-Lambert) without stopping it. A ray that leaves the domain through an opening returns sky radiance; anywhere else it returns the wall.
- **Merge.** The eight probes of the level above are combined with trilinear weights. Buried probes are skipped, and for cascade 0 so are probes hidden behind a thin wall. Each upper probe continues the ray from its own position, so the lower ray is traced slightly past the end of its interval, and a surface it meets hides exactly those upper probes whose continuation starts behind it.
- **Final gather.** Per pixel, 64 cosine-weighted directions are read from cascade 0, and the interval between the surface and the start of cascade 0 is traced from the surface itself by 16 short cones. That per-pixel near field is what keeps contact shadows. The lookup position is pushed off the surface in proportion to the filter weight that falls behind the surface's tangent plane, which removes most bleeding through thin walls without seams.

### Bounces

One solve computes emission plus direct lighting for the current frame. Indirect light is a Jacobi iteration of the rendering equation across frames: the radiance cache reflects the previous solve, so bounce *k* of a change arrives *k* frames later and the solution converges geometrically. Nothing is blended over time, so there is no history to reject and nothing can trail. *Bounces* in the quality drawer runs the solve more than once per frame.

Each kind of light is counted once: surface emitters and the sky through the cascades; painted strokes through the emission density; the sun and the light apertures analytically in the radiance cache and again, per pixel, in the lighting pass (the pixel's own direct term is not in the cascades it reads, because cascades carry radiance leaving *other* surfaces).

### Split Radiance Cascades

Evaluated from the paper and from measurements of this solver. **Split RC itself has not been prototyped**, so it has not been adopted.

Adopted from it: interval scaling of 4 with equal spatial and angular error; equal-area directions; pre-averaging; the per-pixel near-field interval; skipping cascade 0 probes that are not near a surface.

Not adopted: the hashed sparse probe set and ray splitting.

- It is driven by the screen: probes exist where pixels are, and rays start at visible surfaces. Light reflected by surfaces that are not visible needs its secondary cache, which converges by temporal accumulation; the paper leaves moving objects under accumulation to future work. That conflicts with the requirement here that lighting never lags behind an edit.
- It assumes hardware ray tracing: one full-length ray per pixel is 2 M rays per frame at 1080p. Marched through a distance field in a compute shader that is this solver's entire cascade budget.
- Depositing needs atomic accumulation and a hash rebuilt every frame. WebGPU offers 32-bit integer atomics only, so radiance would have to be accumulated in fixed point (the caustic pass does exactly that, for a much smaller problem).

What it would buy is a finer cascade 0, which is the source of the largest measured error below. A sparse cascade 0 near surfaces remains the most valuable next step, and it is not done.

## Daylight and openings

Windows and skylights are real holes carved out of the room's distance field, each with its reveal (the wall thickness), glazing bars and a shutter. The sky is an analytic clear-sky distribution (Preetham-style) blended towards a CIE overcast sky by cloud cover, evaluated on the CPU into a 128 x 64 radiance map when the daylight changes. Cascade rays that leave through an opening read it, which is how sky light, its colour and its soft shadows enter the room.

The sun is separate and analytic: 100 klx above the atmosphere with per-channel extinction along the air mass, visibility through each opening computed from the opening's inner and outer rectangles (so the reveal casts its shadow and the glazing bars theirs, with a penumbra from the sun's angular size), then marched through the distance field for everything inside the room.

## Glass

Glass does not occlude the global illumination. What it does:

- **In the solver.** Cascade rays and shadow rays passing through glass are tinted by Beer-Lambert absorption along the distance they travel inside it. Frosted sheets remove the scattered share of a direct beam and re-emit it diffusely from the sheet (the glow volume), so a frosted panel in the sun lights the room softly, and the bounce light it sends is coloured by its tint. Etched areas of a frosted slab let the beam through unscattered.
- **In the picture.** The glass layer gets a cone-traced reflection weighted by Fresnel, a sun glint, and frost scatter gathered from both faces. The view through it is refracted analytically per shape (two interfaces for a slab, with the flute profile perturbing the first normal; a thin-lens deflection for lenses; entry and exit faces for prisms and rods), absorbed over the path length, blurred with a mip of the lit image in proportion to frost and distance behind the glass, and optionally split into three wavelengths for dispersion.
- **Caustics.** For each glass object that bends light (fluted slabs, lenses, prisms, rods; at most four), a regular grid of sun photons (384 x 384 at High quality) is refracted through the analytic shape with Fresnel losses and absorption, followed through the distance field to the first surface, and added to the pixel that sees that surface. Accumulation uses 32-bit atomics with stochastic rounding, then an edge-aware separable filter. In the camera image such glass blocks the direct sunbeam, because the photons deliver it. A flat slab does not redirect light, so its transmitted sun is computed exactly as a tinted (and, if etched, masked) shadow, without photons.

Limits of this: caustics exist for the sun only, not for painted light or lamps; they are added to the camera image, so the light a caustic bounces onward is the plain tinted beam the solver sees, not the focused pattern; photons are followed through one object; refraction of the view is a screen-space lookup, so things outside the frame or hidden behind other objects cannot appear in the glass, and total internal reflection is not followed; the solver sees a thin slab as at least 0.8 voxel thick.

## Atmosphere

Haze is a homogeneous medium with a Henyey-Greenstein phase function. Along each view ray, twelve interleaved steps accumulate single scattering: the sun with its real visibility at every step (which draws the shafts) and, for everything else, the mean radiance stored at cascade 1 probes.

## Motion

Every motion is a function of the loop phase and repeats a whole number of times per loop, so the loop closes exactly and a recording of one loop is the same on every run. Motions (orbit, pendulum, slide, spin, breathe, a recorded gesture path, or modulation of a named parameter) attach to objects, to openings and to the daylight. Strokes may also fade against a monotonic clock.

## Validation against brute force

`?scene=area|umbra|ribbon|enclosure` loads a test scene and `__illuminate.validate()` compares light-meter readings with brute-force integrals. High tier:

| Test | Result |
| --- | --- |
| Thin ribbon, 2 m x 6 cm, black room | floor below +7.5 %; 0.75 m aside +4.4 %; 1.5 m -4.6 %; 2.25 m -17 %; wall +12 %; ceiling -12 % |
| Area emitter, 0.8 m square, black room | floor below +26 %; 0.5 m +20 %; 1 m +3 %; 1.5 m -9 %; 2.2 m -30 % |
| Same with a blocker | umbra centre 0.00 klx (unoccluded 3.13); 0.06 klx at 0.5 m |
| Grey enclosure, albedo 0.5 | direct mean +11 %; converged +13 %; converged / direct = 2.04 (exact 2.00) |

- The bounce loop conserves energy to about 2 %.
- Surface emitters are 11 to 14 % too bright in total: treating every axis crossing as a full hit, plus fractional coverage beside it, dilates silhouettes. Binary visibility removes the bias but leaves visible blotches; the coverage radius is the compromise.
- Light directly under a nearby emitter is 20 to 25 % too strong and falls off too fast, because cascade 0 is read 10 to 15 cm off the surface. Finer cascade 0 spacing is the fix (see Split RC above).
- The medium tier has larger near-field errors (measured on the prototype: +39 % under the area emitter, +26 % under the ribbon).

## Verification

Run on the opening scene at the medium tier with the clock paused, reading illuminance at five fixed points with the solver's own light meter. Zero means identical to the last printed digit.

| Check | Result |
| --- | --- |
| Emitter switched off | The ribbon's 6.3 klx under it falls to 55 %, 17 %, 7 %, 3 %, 1.4 %, 0.6 % over six frames (direct light goes in the first; the rest is the indirect echo). Switched back on, the reading returns exactly |
| Blocker moved and returned | Readings change by up to 1.3 klx while it is away; residual after it returns: 0 |
| Sources outside the view | Camera turned to face the opposite corner: change 0 (the solver does not depend on the camera) |
| Colour bleed | Floor in front of the ceramic panel: red / blue ratio 3.69 with the panel, 2.80 with it painted grey of equal luminance; on a surface facing it, 22 against 2.6 |
| Closing the windows | Shutters to 1: readings fall from 5.0 to 9.6 klx to 1.5 to 8.3 klx (what the ribbon alone gives), about a third of the drop in the first frame; reopened: residual 0 |
| Glass | Moving or turning the fluted slab moves its refraction and its caustic with it in the same frame; the caustic disappears when the slab leaves the sun (checked by eye) |
| Contact shadows | Present under the bench, the plinth and the screen at the default tier (checked by eye) |
| Bloom off | The picture holds without it; bloom only adds a glow around sources (checked by eye). The bloom input is compressed so a small source far brighter than white cannot flood the frame |
| Stability | 200 further frames: drift 0 |
| Save and load | Export, parse, migrate, load: readings identical; the same loop phase a loop later: identical |

Also exercised: undo and redo across structural edits, tier changes while running, stills at twice the screen size (3864 x 2172), frame-by-frame loop capture, frost etching with single-step undo, gesture-recorded motion, and all five presets.

## Performance

See the README for the table and for how the numbers were obtained. Where the time goes at the medium tier, in milliseconds of GPU compute: final gather and lighting 8.0, cascades 2.8, radiance cache 1.3, caustics 1.1, voxelisation and stroke splatting 0.8 (only on frames where something moved), glass 0.35.

The final gather dominates and does not depend on the lighting tier, which is why adaptive quality lowers the render resolution before it lowers the tier.

## Known limitations

- Geometry thinner than about 1.5 voxels can be stepped over or leak. The louver slats in *Morning Aperture* are about one voxel thick at the default tier, which is why the edges of their stripes are slightly ragged; at Low they leak.
- Probe interpolation still bleeds faintly around thin walls at oblique angles, and cascade transitions can show as soft bands on large uniform walls under a single small emitter.
- Painted strokes are prefiltered to at least 1.5 density cells, so their own near field is softer than the mesh suggests. A stroke holds at most 72 points.
- Sun shadows come from the distance field: they are soft at the scale of a third of a voxel and cannot be sharper.
- At most eight openings, four light apertures, four frosted sheets that glow, four caustic casters, one etched panel.
- Specular reflection is a single cone per pixel for surfaces smoother than roughness 0.6; there are no mirror-sharp reflections and no reflections of reflections.
- Loop video is recorded with `MediaRecorder` from frames rendered at fixed loop phases and paced in real time; the frames are deterministic, the encoder's timestamps are not exact.
- Not built: depth of field, a progressive reference mode, caustics from sources other than the sun.

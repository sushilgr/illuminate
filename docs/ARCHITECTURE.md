# Rendering architecture

Status: lighting-core prototype. This document describes what is implemented now, what was measured, and what is known to be wrong.

## Pipeline

Every frame, in this order:

1. **Voxelise** (only when the scene changed). Analytic primitives (room shell, rounded boxes, cylinders, spheres, arc walls, slats, boolean apertures) are evaluated into 3D textures: a signed distance field, diffuse reflectance and emitted radiance. Thin emitters such as ribbons are not voxelised as solids; they are splatted as a prefiltered emission density with an anisotropy tensor and a mip chain.
2. **Radiance cache.** Every surface voxel gets its outgoing radiance: `L = Le + albedo / pi * (E_gather + E_sun)`. `E_gather` is read from the cascades of the previous solve.
3. **Cascades**, top-down. Each cascade traces its radiance interval for every probe direction against the distance field and merges with the cascade above.
4. **G-buffer.** three.js `WebGPURenderer` rasterises the visible meshes (generated from the same primitive parameters) into albedo, world normal, emitted radiance and depth through TSL node materials and MRT.
5. **Deferred final gather** (compute). Per pixel, 64 cosine-weighted directions are read from cascade 0 and continued from the surface itself by 16 short cones.
6. **Display transform**, once: exposure, AgX tone mapping, sRGB, through three.js `RenderPipeline`.

All lighting is linear HDR. The GI passes are WGSL compute kernels on the renderer's own `GPUDevice`; their textures, buffers and bind groups are created and owned by `GISystem` and are never touched by three.js. The only shared resources are the G-buffer attachments, read after the raster pass. Nothing is read back in the frame loop: GPU timings and the light meter use asynchronous buffer maps.

## Cascade hierarchy

| | Probe spacing | Directions traced | Directions stored | Interval |
| --- | --- | --- | --- | --- |
| cascade 0 | 4 voxels | 8 x 8 | 8 x 8 | 1 to 2 spacings |
| cascade 1 | 8 voxels | 16 x 16 | 8 x 8 | x 4 |
| cascade 2 | 16 voxels | 32 x 32 | 16 x 16 | x 4 |
| cascade 3 | 32 voxels | 64 x 64 | 32 x 32 | to infinity |

At the `high` tier the voxel is 3.5 cm, so cascade 0 probes are 14 cm apart and the intervals are 0.14-0.28 m, 0.28-1.12 m, 1.12-4.48 m and beyond. The domain is 6.72 x 3.36 x 5.6 m and encloses the room with a wall margin.

- Probe spacing doubles and the direction count quadruples per level, as in the paper. The interval length grows by 4 rather than 2, which keeps the spatial and the angular error of each level equal. With a factor of 2.5 the upper probes were far too coarse for their distance: under a blocker hung halfway below an emitter, the floor still received 56 % of the unoccluded light where it should have been in full umbra.
- Directions use an equal-area square-to-sphere map, so the 2 x 2 children of a direction tile are exactly its four refined directions. Cascades above 0 store the average of each 2 x 2 group, which is what the level below reads.
- Rays are cones marched through the distance field. A surface crossed by the axis stops the ray; surfaces beside it contribute fractional coverage; thin emitters add their prefiltered emission. The interval between a surface point and the start of cascade 0 is traced per pixel, which is what keeps contact shadows.
- **Merge.** The eight probes of the level above are combined with trilinear weights. Buried probes are skipped, and for cascade 0 so are probes hidden behind a thin wall. Each upper probe continues the ray from its own position, so the lower ray is traced slightly past the end of its interval and a surface it meets hides exactly those upper probes whose continuation starts behind it. Without this, thin objects near an interval boundary were lost between the two levels.
- **Final gather.** The lookup position is pushed off the surface in proportion to the filter weight that falls behind the surface's tangent plane, which removes most bleeding through thin walls without leaving seams.

## Bounces

One solve computes emission plus direct lighting for the current frame. Indirect light is a Jacobi iteration of the rendering equation across frames: the radiance cache reflects the previous solve, so bounce *k* of a change arrives *k* frames later and the solution converges geometrically. Nothing is blended over time, so there is no history to reject and nothing can trail. `iterations` runs the solve more than once per frame when faster convergence is worth the cost.

Measured on the flagship scene (high tier): after switching the only emitter off, mean irradiance falls to 37 %, 13 %, 4.6 %, 1.7 %, 0.6 % of its former value over the next five frames. The first step is the direct light; the rest is the indirect echo.

## Validation

`?scene=area|umbra|ribbon|enclosure` loads a test scene and `__illuminate.validate()` compares light-meter readings with brute-force integrals. High tier, measured on an Apple silicon GPU (Metal) in the Claude desktop browser (Chromium 152):

| Test | Result |
| --- | --- |
| Thin ribbon, 2 m x 6 cm at 1.8 m, black room | floor below: +0.8 %; 0.75 m aside: -1.5 %; 1.5 m: -9 %; 2.25 m: -21 %; ceiling 1 m above: +20 % |
| Area emitter, 0.8 m square at 2 m, black room | floor below: +23 %; 1 m aside: +4 %; 1.5 m: -8 %; 2.2 m: -26 % |
| Same with a blocker | umbra centre: 1 % of the unoccluded value (should be 0) |
| Grey enclosure, albedo 0.5 | direct mean +14 %; converged mean / direct mean = 2.04 (exact: 2.00) |
| 200 further frames | drift 0 |
| Camera turned away from the scene | change 0 |
| Blocker moved and returned | residual 0 |

Reading these numbers:

- The bounce loop conserves energy to about 2 %.
- Surface emitters are about 14 % too bright in total. Treating every axis crossing as a full hit, plus fractional coverage beside it, dilates silhouettes. Binary visibility removes the bias (+4 %) but leaves visible blotches from an emitter this small; the coverage radius is a compromise and is exposed as a parameter.
- Light directly under a nearby emitter is about 20 % too strong and falls off too fast. Cascade 0 is read 10 to 15 cm off the surface, and that is closer to the emitter. Finer cascade 0 spacing is the fix; see below.
- The `medium` tier (5.25 cm voxels) has larger near-field errors: +39 % under the area emitter and +26 % under the ribbon.

## Split Radiance Cascades

Evaluated from the paper and from measurements of this prototype. **Split RC itself has not been prototyped**, so it has not been adopted.

Adopted from it: interval scaling of 4 with equal spatial and angular error; equal-area directions; pre-averaging; the per-pixel near-field interval; skipping cascade 0 probes that are not near a surface.

Not adopted: the hashed sparse probe set and ray splitting.

- It is driven by the screen: probes exist where pixels are, and rays start at visible surfaces. Light reflected by surfaces that are not visible needs its secondary cache, which converges by temporal accumulation. The paper leaves moving objects under accumulation to future work. That conflicts with the requirement here that lighting never lags behind an edit.
- It assumes hardware ray tracing: one full-length ray per pixel is 2 M rays per frame at 1080p, which the paper traces in 1.3 to 6 ms on an RTX 3080 laptop with OptiX. Marched through a distance field in a compute shader that is comparable to this prototype's entire cascade budget.
- Depositing needs atomic accumulation and a hash rebuilt every frame. WebGPU offers 32-bit integer atomics only, so radiance would have to be accumulated in fixed point.
- Its memory advantage is small in this room. At the high tier the scene volumes take about 115 MB and all cascades together 29 MB.

What it would buy is a finer cascade 0. Dense storage with 64 directions at 7 cm spacing costs about 190 MB. A sparse set near surfaces should cost roughly 30 MB (an estimate, from the share of probes within reach of a surface) and would halve the lookup offset behind the near-field error above. That is the reason to revisit sparse storage for cascade 0 once the rest of the application exists.

## Known limitations

- Geometry thinner than 1.5 voxels can be stepped over. Louvers and screens need to respect that.
- Probe interpolation still bleeds faintly around thin walls at oblique angles.
- Ribbons are prefiltered to at least 1.5 density cells, so their own near field is softer than the mesh suggests.
- The image is not anti-aliased yet; thin emitters stair-step.
- Diffuse transport only. Glass, specular reflection and caustics are separate techniques that are not built yet.

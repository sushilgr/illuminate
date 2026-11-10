// One drawing style for every icon: 20 x 20 grid, 1.4 px round strokes, no fills.
const S = 'fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"';
const p = (d: string) => `<path ${S} d="${d}"/>`;
const c = (cx: number, cy: number, r: number) => `<circle ${S} cx="${cx}" cy="${cy}" r="${r}"/>`;

export const ICONS = {
  select: p('M5 3.5l9.5 5.2-4 1.3 2.6 5-1.7.9-2.6-5-3 2.8z'),
  navigate: c(10, 10, 6.5) + p('M10 3.5c-2.4 2-2.4 11 0 13M10 3.5c2.4 2 2.4 11 0 13M3.5 10h13'),
  move: p('M10 3v14M3 10h14M10 3l-2 2M10 3l2 2M10 17l-2-2M10 17l2-2M3 10l2-2M3 10l2 2M17 10l-2-2M17 10l-2 2'),
  rotate: p('M15.5 6.5A6.5 6.5 0 1 0 16.5 10M15.5 3v3.5H12'),
  scale: p('M4 16V9M4 16h7M4 16l11.5-11.5M11 4.5h4.5V9'),
  paint: p('M4 16c2.5.4 4-.6 4-2.5 0-1.2 1-2.2 2.2-2.2M10.2 11.3l5.6-6.8a1.2 1.2 0 0 0-1.9-1.5l-5 7'),
  erase: p('M8 16h8M5.5 13.5l7-8.5 4 3.3-6.3 7.7H7z') ,
  add: p('M10 4v12M4 10h12'),
  etch: p('M4 4h12v12H4zM7 13c1-4 3-6 6-6M7 8l1.5 1.5'),
  meter: c(10, 11, 5.5) + p('M10 11l2.5-3M10 3v2M4.3 5.5l1.4 1.3M15.7 5.5l-1.4 1.3'),
  compare: p('M3.5 5h13v10h-13zM10 3v14') + p('M12.5 8l2 2-2 2'),
  play: p('M6.5 4.5v11l9-5.5z'),
  pause: p('M7 4.5v11M13 4.5v11'),
  timeline: p('M3 10c1.8-6.5 4-6.5 7 0s5.2 6.5 7 0M3 16.5h14'),
  presets: p('M4 4h5v5H4zM11 4h5v5h-5zM4 11h5v5H4zM11 11h5v5h-5z'),
  capture: p('M3.5 6.5h3l1.2-2h4.6l1.2 2h3v9h-13z') + c(10, 10.8, 2.6),
  settings: p('M4 6h7M14 6h2M4 14h2M9 14h7') + c(12.5, 6, 1.5) + c(7.5, 14, 1.5),
  present: p('M3.5 4.5h13v9h-13zM7 16.5h6M10 13.5v3'),
  help: c(10, 10, 6.5) + p('M8 8.2a2 2 0 1 1 2.8 1.9c-.5.3-.8.7-.8 1.4M10 13.6v.2'),
  undo: p('M7 5L3.5 8.5 7 12M3.5 8.5H12a4 4 0 0 1 0 8H9'),
  redo: p('M13 5l3.5 3.5L13 12M16.5 8.5H8a4 4 0 0 0 0 8h3'),
  eye: p('M2.5 10s3-5 7.5-5 7.5 5 7.5 5-3 5-7.5 5-7.5-5-7.5-5z') + c(10, 10, 2),
  eyeOff: p('M3 3l14 14M8 5.3A7.6 7.6 0 0 1 10 5c4.5 0 7.5 5 7.5 5a12 12 0 0 1-2.2 2.7M12.8 14.5A7 7 0 0 1 10 15c-4.5 0-7.5-5-7.5-5a12 12 0 0 1 3-3.3'),
  trash: p('M4.5 6h11M8 6V4.5h4V6M6 6l.6 9.5h6.8L14 6'),
  duplicate: p('M7 7h9v9H7zM4 13V4h9'),
  close: p('M5 5l10 10M15 5L5 15'),
  panel: p('M3.5 4.5h13v11h-13zM12.5 4.5v11'),
  sun: c(10, 10, 3) + p('M10 3v1.8M10 15.2V17M3 10h1.8M15.2 10H17M5 5l1.3 1.3M13.7 13.7L15 15M5 15l1.3-1.3M13.7 6.3L15 5'),
  room: p('M3.5 16.5V7L10 3.5 16.5 7v9.5zM8 16.5v-5h4v5'),
  camera: p('M3.5 7h9.5v7H3.5zM13 9.5l3.5-2v6l-3.5-2'),
  finish: c(10, 10, 6.5) + p('M10 3.5v13M10 6a4 4 0 0 1 0 8'),
  haze: p('M4 7c2-1.5 4 1.5 6 0s4-1.5 6 0M4 11c2-1.5 4 1.5 6 0s4-1.5 6 0M4 15c2-1.5 4 1.5 6 0s4-1.5 6 0'),
  form: p('M4 7l6-3 6 3v6.5l-6 3-6-3zM4 7l6 3 6-3M10 10v6.5'),
  screen: p('M4 4.5l4 2v10l-4-2zM8 6.5l4-2v10l-4 2M12 4.5l4 2v10l-4-2'),
  light: c(10, 8.5, 4.2) + p('M8 15h4M8.7 17h2.6'),
  stroke: p('M3.5 13c3-7 5 2.5 8-2.5s3-4.5 5-3'),
  spot: p('M4 4.5l5.5 3.2-3 4.6zM9 9.5l7.5 4M7.5 12l4.5 5'),
  glass: p('M6 3.5h8v13H6zM8.5 6.5v7M11 5.5v3'),
  window: p('M4.5 3.5h11v13h-11zM10 3.5v13M4.5 10h11'),
} as const;

export type IconName = keyof typeof ICONS;

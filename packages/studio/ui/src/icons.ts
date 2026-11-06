// 16×16 line icons, drawn for Studio. They take the text color.

const P: Record<string, string> = {
  play: '<path d="M5 3.5v9l7.5-4.5z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="4" y="3.5" width="2.6" height="9" rx=".6" fill="currentColor" stroke="none"/><rect x="9.4" y="3.5" width="2.6" height="9" rx=".6" fill="currentColor" stroke="none"/>',
  step: '<path d="M4 3.5v9l6-4.5z" fill="currentColor" stroke="none"/><rect x="11" y="3.5" width="1.8" height="9" rx=".5" fill="currentColor" stroke="none"/>',
  restart: '<path d="M3.5 8a4.5 4.5 0 1 0 1.4-3.3"/><path d="M3.5 2.8v2.6h2.6"/>',
  pick: '<path d="M3 2.5l4 10.5 1.6-4.4L13 7z" fill="currentColor" fill-opacity=".25"/><path d="M9 9l3.5 3.5"/>',
  volume: '<path d="M3 6.2h2.4L8.6 3.5v9L5.4 9.8H3z" fill="currentColor" fill-opacity=".25"/><path d="M10.6 5.6a3.4 3.4 0 0 1 0 4.8M12.3 4a5.7 5.7 0 0 1 0 8"/>',
  muted: '<path d="M3 6.2h2.4L8.6 3.5v9L5.4 9.8H3z" fill="currentColor" fill-opacity=".25"/><path d="M10.5 6l3.5 4M14 6l-3.5 4"/>',
  check: '<path d="M3 8.4l3.2 3.1L13 4.6"/>',
  flask: '<path d="M6.2 2.5h3.6M6.8 2.5v4L3.4 12.3a1 1 0 0 0 .9 1.4h7.4a1 1 0 0 0 .9-1.4L9.2 6.5v-4"/><path d="M4.8 10h6.4"/>',
  review: '<path d="M8 2.6l1.6 3.3 3.6.5-2.6 2.5.6 3.6L8 10.8l-3.2 1.7.6-3.6L2.8 6.4l3.6-.5z"/>',
  search: '<circle cx="7" cy="7" r="4"/><path d="M10 10l3.5 3.5"/>',
  chevron: '<path d="M6 4l4 4-4 4"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  copy: '<rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.2"/><path d="M10.5 5.5V4.2A1.2 1.2 0 0 0 9.3 3H4.2A1.2 1.2 0 0 0 3 4.2v5.1a1.2 1.2 0 0 0 1.2 1.2h1.3"/>',
  braces: '<path d="M6 2.8c-1.6 0-1.8.7-1.8 2v1.1c0 .9-.4 1.6-1.4 2.1 1 .5 1.4 1.2 1.4 2.1v1.1c0 1.3.2 2 1.8 2M10 2.8c1.6 0 1.8.7 1.8 2v1.1c0 .9.4 1.6 1.4 2.1-1 .5-1.4 1.2-1.4 2.1v1.1c0 1.3-.2 2-1.8 2"/>',
  open: '<path d="M9 3h4v4M13 3L7.5 8.5"/><path d="M11.5 9.5v2.8a.8.8 0 0 1-.8.8H3.8a.8.8 0 0 1-.8-.8V5.4a.8.8 0 0 1 .8-.8h2.8"/>',
  folder: '<path d="M2.5 4.3a.8.8 0 0 1 .8-.8h3l1.4 1.6h5a.8.8 0 0 1 .8.8v6.3a.8.8 0 0 1-.8.8H3.3a.8.8 0 0 1-.8-.8z"/>',
  error: '<circle cx="8" cy="8" r="5.5" fill="currentColor" fill-opacity=".18"/><path d="M8 5v3.4M8 10.6v.2"/>',
  warning: '<path d="M8 2.8l5.6 9.7H2.4z" fill="currentColor" fill-opacity=".18"/><path d="M8 6.6v2.6M8 10.9v.2"/>',
  info: '<circle cx="8" cy="8" r="5.5"/><path d="M8 7.4v3.6M8 5.2v.2"/>',
  idea: '<path d="M6 11.5h4M6.5 13.5h3M5.3 9.4a4 4 0 1 1 5.4 0c-.5.5-.7 1-.7 1.6H6c0-.6-.2-1.1-.7-1.6z"/>',
  spark: '<path d="M8 2v3M8 11v3M2 8h3M11 8h3M4 4l1.8 1.8M10.2 10.2L12 12M12 4l-1.8 1.8M5.8 10.2L4 12"/>',
  bolt: '<path d="M9 2L4 9h3.6L7 14l5-7H8.4z" fill="currentColor" fill-opacity=".2"/>',
  plug: '<path d="M6 2.5v3M10 2.5v3M4.5 5.5h7v2.2a3.5 3.5 0 0 1-7 0zM8 11.2v2.3"/>',
  layers: '<path d="M8 2.6l5.5 2.9L8 8.4 2.5 5.5z"/><path d="M2.5 8.2L8 11.1l5.5-2.9M2.5 10.9L8 13.8l5.5-2.9"/>',
  terminal: '<rect x="2.5" y="3" width="11" height="10" rx="1.2"/><path d="M5 6.5l2 1.5-2 1.5M8.5 10H11"/>',
  activity: '<path d="M2 8.5h2.6l1.6-4 3.2 8 1.6-4H14"/>',
  scene: '<rect x="2.5" y="3" width="11" height="10" rx="1.2"/><path d="M2.5 10.5l3.2-3 2.6 2.4 1.8-1.6 3.4 2.9"/><circle cx="10.5" cy="6" r=".9" fill="currentColor"/>',

  // Entity kinds
  player: '<circle cx="8" cy="4.6" r="2"/><path d="M4.5 13.5c0-2.6 1.6-4.6 3.5-4.6s3.5 2 3.5 4.6"/>',
  enemy: '<path d="M3 12.5V7.5a5 5 0 0 1 10 0v5l-1.7-1.3-1.6 1.3L8 11.2l-1.7 1.3-1.6-1.3z"/><circle cx="6.3" cy="7.4" r=".8" fill="currentColor"/><circle cx="9.7" cy="7.4" r=".8" fill="currentColor"/>',
  hazard: '<path d="M2.5 13l2.2-6 2.2 6 2.2-6 2.2 6 2.2-6"/><path d="M2 13.2h12"/>',
  goal: '<path d="M4 14V2.5"/><path d="M4 3h8l-2 2.5L12 8H4" fill="currentColor" fill-opacity=".25"/>',
  checkpoint: '<path d="M4 14V2.5"/><path d="M4 3h6.5v5H4"/>',
  coin: '<circle cx="8" cy="8" r="5"/><path d="M8 5.2v5.6M6.6 6.4h2.2a1 1 0 0 1 0 2H7.2a1 1 0 0 0 0 2h2.2"/>',
  platform: '<rect x="2" y="7" width="12" height="3.5" rx=".8"/><path d="M4 10.5l-1 2.5M12 10.5l1 2.5"/>',
  body: '<rect x="3.5" y="3.5" width="9" height="9" rx="1.5"/><path d="M3.5 8h9"/>',
  light: '<path d="M8 2v1.5M8 12.5V14M2 8h1.5M12.5 8H14M3.8 3.8l1 1M11.2 11.2l1 1M12.2 3.8l-1 1M4.8 11.2l-1 1"/><circle cx="8" cy="8" r="2.6" fill="currentColor" fill-opacity=".25"/>',
  camera: '<rect x="2" y="5" width="9" height="7" rx="1.2"/><path d="M11 7.5l3-1.8v5.6l-3-1.8"/>',
  script: '<path d="M5.5 5L2.5 8l3 3M10.5 5l3 3-3 3M9 3.5l-2 9"/>',
  emitter: '<circle cx="8" cy="8" r="1.4" fill="currentColor"/><path d="M8 2.5v2M8 11.5v2M2.5 8h2M11.5 8h2M4.2 4.2l1.4 1.4M10.4 10.4l1.4 1.4M11.8 4.2l-1.4 1.4M5.6 10.4l-1.4 1.4"/>',
  tilemap: '<rect x="2.5" y="2.5" width="11" height="11" rx="1"/><path d="M2.5 6.2h11M2.5 9.8h11M6.2 2.5v11M9.8 2.5v11"/>',
  joint: '<circle cx="4.5" cy="11.5" r="2"/><circle cx="11.5" cy="4.5" r="2"/><path d="M6 10l4-4"/>',
  mesh: '<path d="M8 2.5l5 2.8v5.4L8 13.5l-5-2.8V5.3z"/><path d="M3 5.3l5 2.8 5-2.8M8 8.1v5.4"/>',
  sprite: '<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><circle cx="6" cy="6.2" r="1.2"/><path d="M2.5 11l3.5-3 3 2.5 2-1.5 2.5 2"/>',
  tween: '<path d="M2.5 12.5C6 12.5 6 3.5 13.5 3.5"/><circle cx="2.5" cy="12.5" r="1" fill="currentColor"/><circle cx="13.5" cy="3.5" r="1" fill="currentColor"/>',
  entity: '<path d="M8 2.5l5 2.8v5.4L8 13.5l-5-2.8V5.3z"/>',
  zone: '<rect x="2.5" y="3.5" width="11" height="9" rx="1" stroke-dasharray="2 1.6"/>',

  // File kinds
  file: '<path d="M4 2.5h5l3 3v8H4z"/><path d="M9 2.5v3h3"/>',
  test: '<path d="M4 2.5h5l3 3v8H4z"/><path d="M6 9.3l1.4 1.4 2.6-2.8"/>',
  design: '<path d="M4 2.5h5l3 3v8H4z"/><path d="M6 8h4M6 10.5h3"/>',
  config: '<circle cx="8" cy="8" r="2"/><path d="M8 2.5v1.8M8 11.7v1.8M2.5 8h1.8M11.7 8h1.8M4.1 4.1l1.3 1.3M10.6 10.6l1.3 1.3M11.9 4.1l-1.3 1.3M5.4 10.6l-1.3 1.3"/>',
  asset: '<rect x="2.5" y="3" width="11" height="10" rx="1.2"/><circle cx="6" cy="6.5" r="1.2"/><path d="M2.5 11.5l3.8-3.3 2.6 2.2 1.6-1.4 3 2.6"/>',
  prefab: '<rect x="3" y="3" width="6.5" height="6.5" rx="1"/><path d="M6.5 12.8h5.3a1 1 0 0 0 1-1V6.5"/>',
};

export function icon(name: string, cls = ""): SVGSVGElement {
  const wrap = document.createElement("span");
  wrap.innerHTML = `<svg class="icon ${cls}" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] ?? P.entity}</svg>`;
  return wrap.firstElementChild as SVGSVGElement;
}

/** The kind of an entity, from its components, for its icon and color. */
export function entityKind(components: readonly string[], id = ""): string {
  const has = (c: string) => components.includes(c);
  if (has("platformer") || has("topdown") || has("character") || /^player$/i.test(id)) return "player";
  if (has("camera") || has("camera3d")) return "camera";
  if (has("light")) return "light";
  if (has("goal")) return "goal";
  if (has("checkpoint")) return "checkpoint";
  if (has("patrol")) return "enemy";
  if (has("hazard")) return "hazard";
  if (has("collectible")) return "coin";
  if (has("emitter")) return "emitter";
  if (has("tilemap")) return "tilemap";
  if (has("cameraZone")) return "zone";
  if (has("joint")) return "joint";
  if (has("mesh")) return "mesh";
  if (has("body")) return "platform";
  if (has("sprite")) return "sprite";
  if (has("script")) return "script";
  return "entity";
}

/** The icon for a component in the inspector. */
export function componentIcon(name: string): string {
  const map: Record<string, string> = {
    transform: "zone", body: "body", sprite: "sprite", script: "script", mesh: "mesh", collectible: "coin",
    tween: "tween", hazard: "hazard", patrol: "enemy", goal: "goal", joint: "joint", platformer: "player",
    topdown: "player", character: "player", emitter: "emitter", checkpoint: "checkpoint", light: "light",
    cameraZone: "zone", camera: "camera", camera3d: "camera", tilemap: "tilemap",
  };
  return map[name] ?? "entity";
}

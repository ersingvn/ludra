// The component schema the mock's /__ludra/project gives, as `ludra components --json` does. A subset of
// the real one, copied from @ludra/core (packages/core/src/components.ts) for v0.99; refresh it by hand.

import type { ComponentSpec } from "../protocol.ts";

export const MOCK_COMPONENTS: Record<string, ComponentSpec> = {
  "transform": {
    "description": "Position of the entity's center. 2D: pixels, +x right, +y down. 3D (\"dimensions\": 3): metres, +x right, +y up, +z toward the viewer.",
    "fields": {
      "x": {
        "type": "number",
        "description": "Center x (2D px, 3D m)."
      },
      "y": {
        "type": "number",
        "description": "Center y (2D px, +y down; 3D m, +y up)."
      },
      "z": {
        "type": "number",
        "default": 0,
        "description": "3D only: center z in metres, +z toward the viewer."
      },
      "rotation": {
        "type": "rotation",
        "default": 0,
        "description": "2D: degrees clockwise (rapier only; arcade bodies never rotate). 3D: { \"x\", \"y\", \"z\" } in degrees, applied y (turn), then x (tilt), then z (roll)."
      }
    }
  },
  "body": {
    "description": "Collider. static = never moves (ground, walls). dynamic = falls with gravity and collides with other bodies. kinematic = moves at a constant velocity, ignores gravity. With arcade physics (the default) every body is an axis-aligned box; with \"physics\": \"rapier\" bodies can be circles or capsules, rotate, and have friction and mass.",
    "requires": [
      "transform"
    ],
    "fields": {
      "type": {
        "type": "enum",
        "values": [
          "static",
          "dynamic",
          "kinematic"
        ],
        "default": "static",
        "description": "How the body moves."
      },
      "width": {
        "type": "number",
        "min": 0.001,
        "description": "Collider width (2D px, 3D m)."
      },
      "height": {
        "type": "number",
        "min": 0.001,
        "description": "Collider height (2D px, 3D m)."
      },
      "depth": {
        "type": "number",
        "min": 0,
        "default": 0,
        "description": "3D only: size along z in metres. 0 = the same as width."
      },
      "sensor": {
        "type": "boolean",
        "default": false,
        "description": "Sensors detect overlaps but never block movement (coins, triggers)."
      },
      "gravityScale": {
        "type": "number",
        "default": 1,
        "description": "Multiplier on world gravity for dynamic bodies."
      },
      "bounce": {
        "type": "number",
        "min": 0,
        "default": 0,
        "description": "How much speed a dynamic body keeps when it hits a solid: 0 stops it, 1 bounces it back at full speed (balls, pinballs)."
      },
      "vx": {
        "type": "number",
        "default": 0,
        "description": "Initial horizontal velocity in px/s."
      },
      "vy": {
        "type": "number",
        "default": 0,
        "description": "Initial vertical velocity in px/s (3D: m/s, +y up)."
      },
      "vz": {
        "type": "number",
        "default": 0,
        "description": "3D only: initial velocity along z in m/s."
      },
      "shape": {
        "type": "enum",
        "values": [
          "box",
          "circle",
          "capsule",
          "polygon",
          "polyline",
          "sphere",
          "cylinder",
          "convex",
          "mesh"
        ],
        "default": "box",
        "description": "Rapier only. 2D: circle (diameter = width), capsule (a rounded box, upright when taller than wide), polygon (the convex shape around `points`), polyline (an open line through `points`; static or kinematic only). 3D: box, sphere (diameter = width), capsule (upright, height total, radius width/2), cylinder (upright), convex (the hull around [x, y, z] `points`, or around a model), mesh (exact triangles: `points` + `triangles`, or a model's; static or kinematic only, for terrain, caves and level geometry)."
      },
      "points": {
        "type": "points",
        "default": [],
        "description": "Rapier only, for polygon and polyline shapes: [[x, y], ...] offsets from the center in px; for 3D convex and mesh shapes [[x, y, z], ...] in metres. width and height stay the bounding box."
      },
      "triangles": {
        "type": "points",
        "default": [],
        "description": "3D mesh shape: [[a, b, c], ...] indices into `points`, one per triangle. Generate them for terrain, or leave them out and use a model."
      },
      "model": {
        "type": "string",
        "default": "",
        "description": "3D convex and mesh shapes: the glTF model whose geometry becomes the collider, fitted exactly like the entity's mesh (fit, scale, turn, offset). \"\" = the mesh's own model. Point it at a simpler model to collide with fewer triangles than you draw."
      },
      "friction": {
        "type": "number",
        "min": 0,
        "default": 0.5,
        "description": "Rapier only. 0 = ice, 1 = rubber."
      },
      "density": {
        "type": "number",
        "min": 0,
        "default": 1,
        "description": "Rapier only. Mass per area: heavier bodies push lighter ones."
      },
      "fixedRotation": {
        "type": "boolean",
        "default": false,
        "description": "Rapier only. Keeps a dynamic body upright (crates that slide but never tip). Players are always upright."
      },
      "bullet": {
        "type": "boolean",
        "default": false,
        "description": "Rapier only. Continuous collision detection, so fast bodies (bullets, balls) can't pass through thin walls."
      }
    }
  },
  "sprite": {
    "description": "How the entity is drawn: a colored shape, or an image (SVG, PNG...) path relative to the project. An image can be a horizontal spritesheet with animations; platformers pick idle/run/jump/fall automatically, everything else plays run while moving and idle otherwise. Size defaults to the body size.",
    "requires": [
      "transform"
    ],
    "fields": {
      "shape": {
        "type": "enum",
        "values": [
          "rect",
          "circle"
        ],
        "default": "rect",
        "description": "Shape to draw when there is no image."
      },
      "color": {
        "type": "string",
        "default": "#ffffff",
        "description": "Any CSS color. Used when there is no image."
      },
      "image": {
        "type": "string",
        "default": "",
        "description": "Image path relative to the project, e.g. \"assets/player.svg\"."
      },
      "frameWidth": {
        "type": "number",
        "min": 0,
        "default": 0,
        "description": "Width of one spritesheet frame in image pixels. 0 = the whole image is one frame."
      },
      "frameHeight": {
        "type": "number",
        "min": 0,
        "default": 0,
        "description": "Height of one frame in image pixels. 0 = the image height."
      },
      "idle": {
        "type": "frames",
        "default": "0",
        "description": "Frames to loop when standing still, e.g. \"0\" or \"0-1\"."
      },
      "run": {
        "type": "frames",
        "default": "",
        "description": "Frames to loop while moving, e.g. \"2-5\". Empty = use idle."
      },
      "jump": {
        "type": "frames",
        "default": "",
        "description": "Frames while moving up in the air. Empty = use idle."
      },
      "fall": {
        "type": "frames",
        "default": "",
        "description": "Frames while falling. Empty = use jump."
      },
      "fps": {
        "type": "number",
        "min": 0,
        "default": 8,
        "description": "Animation speed in frames per second."
      },
      "flip": {
        "type": "boolean",
        "default": true,
        "description": "Mirror the image while moving left. Draw images facing right."
      },
      "tile": {
        "type": "boolean",
        "default": false,
        "description": "Repeat the image to fill the sprite instead of stretching it (ground, walls, spikes)."
      },
      "variants": {
        "type": "strings",
        "default": [],
        "description": "With tile: more images of the same size, mixed in cell by cell so the repetition doesn't show, e.g. [\"assets/rock2.svg\", \"assets/rock3.svg\"]."
      },
      "width": {
        "type": "number",
        "min": 0,
        "default": 0,
        "description": "Draw width in pixels. 0 = use the body width."
      },
      "height": {
        "type": "number",
        "min": 0,
        "default": 0,
        "description": "Draw height in pixels. 0 = use the body height."
      },
      "layer": {
        "type": "number",
        "default": 0,
        "description": "Higher layers are drawn on top."
      },
      "scale": {
        "type": "number",
        "min": 0,
        "default": 1,
        "description": "Draw size multiplier (a tween can pulse or pop it). Never changes the body."
      },
      "opacity": {
        "type": "number",
        "min": 0,
        "default": 1,
        "description": "0 = invisible, 1 = solid. A tween can fade it."
      }
    }
  },
  "platformer": {
    "description": "Side-view player control: run with left/right, jump with jump. Needs a dynamic body.",
    "requires": [
      "transform",
      "body"
    ],
    "fields": {
      "speed": {
        "type": "number",
        "min": 0,
        "default": 240,
        "description": "Run speed in px/s."
      },
      "jumpSpeed": {
        "type": "number",
        "min": 0,
        "default": 680,
        "description": "Upward launch speed in px/s. Jump height = jumpSpeed² / (2 · gravity)."
      },
      "coyoteTime": {
        "type": "number",
        "min": 0,
        "default": 0.1,
        "description": "Seconds after leaving a ledge during which a jump still works."
      },
      "jumpBuffer": {
        "type": "number",
        "min": 0,
        "default": 0.1,
        "description": "Seconds a jump press is remembered before landing."
      },
      "variableJump": {
        "type": "boolean",
        "default": true,
        "description": "Releasing jump early cuts the jump short."
      },
      "maxSlope": {
        "type": "number",
        "min": 0,
        "default": 50,
        "description": "Rapier only. Steepest slope in degrees the player can walk up; steeper ones slide it back down."
      },
      "stepHeight": {
        "type": "number",
        "min": 0,
        "default": 10,
        "description": "Rapier only. Ledges up to this many px are stepped onto without jumping (stairs, bumps). 0 turns it off."
      },
      "push": {
        "type": "number",
        "min": 0,
        "default": 1,
        "description": "Rapier only. How hard the player pushes dynamic bodies, as a multiple of its own mass. 0 = can't push."
      }
    }
  },
  "collectible": {
    "description": "Removed when a player (platformer or topdown) touches it and adds to the score. Its body must be a sensor.",
    "requires": [
      "transform",
      "body"
    ],
    "fields": {
      "score": {
        "type": "number",
        "default": 1,
        "description": "Points added when collected."
      }
    }
  },
  "patrol": {
    "description": "Moves a kinematic body back and forth between its start position and `distance` pixels along +axis. Use it for moving platforms (players standing on them are carried) and walking enemies.",
    "requires": [
      "transform",
      "body"
    ],
    "fields": {
      "axis": {
        "type": "enum",
        "values": [
          "x",
          "y",
          "z"
        ],
        "default": "x",
        "description": "x = right and back, y = down and back (3D: up), z = toward the viewer and back (3D only)."
      },
      "distance": {
        "type": "number",
        "min": 0,
        "description": "Travel in pixels from the start position along +axis."
      },
      "speed": {
        "type": "number",
        "min": 0,
        "default": 80,
        "description": "Speed in px/s."
      }
    }
  },
  "hazard": {
    "description": "Touching it kills a platformer, which respawns at its start position. Use for spikes, lava and enemies. Its body must be a sensor.",
    "requires": [
      "transform",
      "body"
    ],
    "fields": {
      "stompable": {
        "type": "boolean",
        "default": false,
        "description": "Landing on it from above destroys it and bounces the player instead."
      },
      "score": {
        "type": "number",
        "default": 0,
        "description": "Points added when stomped."
      }
    }
  },
  "goal": {
    "description": "Touching it completes the level: the `won` flag is set and the simulation stops. Its body must be a sensor.",
    "requires": [
      "transform",
      "body"
    ],
    "fields": {
      "requireScore": {
        "type": "number",
        "min": 0,
        "default": 0,
        "description": "Score needed before the goal accepts the player."
      },
      "requires": {
        "type": "object",
        "default": {},
        "description": "Items the player must carry before the goal accepts it, e.g. { \"key\": 1 } (see the \"item\" component). They are not used up."
      },
      "next": {
        "type": "string",
        "default": "",
        "description": "Scene to play after this one is won, e.g. \"scenes/level-2.scene.json\". The browser moves on and keeps score, deaths and lives; each scene is tested on its own."
      }
    }
  },
  "checkpoint": {
    "description": "When a player touches it, that player respawns here after dying (standing on the checkpoint's bottom edge). Fires a checkpoint event once. In the browser, reaching it also saves the player's progress, and Continue starts there. Its body must be a sensor.",
    "requires": [
      "transform",
      "body"
    ],
    "fields": {}
  },
  "camera": {
    "description": "The browser camera follows this entity. Without it, the camera follows the first platformer.",
    "requires": [
      "transform"
    ],
    "fields": {
      "zoom": {
        "type": "number",
        "min": 0.1,
        "default": 1,
        "description": "Camera zoom factor."
      }
    }
  },
  "script": {
    "description": "Custom behavior written in TypeScript or JavaScript: a file that default-exports hooks (start, update, touch). Use it for anything the built-in components don't do: chasing, doors and keys, timers, shooting, boss phases. Run `ludra components script` for the API.",
    "requires": [
      "transform"
    ],
    "fields": {
      "src": {
        "type": "string",
        "description": "Script path relative to the project, e.g. \"scripts/chase.ts\"."
      },
      "params": {
        "type": "object",
        "default": {},
        "description": "Values passed to the script as ctx.params, so one script can serve many entities."
      }
    }
  },
  "tween": {
    "description": "Animates a value over time with easing: a door that slides open, a platform that glides and pauses, a coin that bobs, a sign that fades in. x/y move a kinematic or dynamic body by velocity, so riders are carried like on a patrol. Runs in the simulation (deterministic, testable). Give a list for several: \"tween\": [{ ... }, { ... }]. Scripts start tweens with self.tween({ ... }).",
    "requires": [
      "transform"
    ],
    "fields": {
      "property": {
        "type": "enum",
        "values": [
          "x",
          "y",
          "z",
          "rotation",
          "rotationX",
          "rotationY",
          "scale",
          "opacity"
        ],
        "default": "y",
        "description": "What to animate. z, rotationX and rotationY are 3D. scale and opacity need a sprite."
      },
      "to": {
        "type": "number",
        "default": 0,
        "description": "Target value. Ignored when by is set."
      },
      "by": {
        "type": "number",
        "default": 0,
        "description": "Change relative to the start value (e.g. -120 = up 120 px). Used when not 0."
      },
      "duration": {
        "type": "number",
        "min": 0.01,
        "description": "Seconds for one pass."
      },
      "delay": {
        "type": "number",
        "min": 0,
        "default": 0,
        "description": "Seconds to wait first (and between passes when it repeats)."
      },
      "ease": {
        "type": "enum",
        "values": [
          "linear",
          "sineInOut",
          "quadIn",
          "quadOut",
          "quadInOut",
          "cubicInOut",
          "backOut",
          "elasticOut",
          "bounceOut"
        ],
        "default": "sineInOut",
        "description": "The curve: sineInOut glides, quadOut/backOut snap into place, elasticOut and bounceOut wobble and land."
      },
      "repeat": {
        "type": "enum",
        "values": [
          "once",
          "loop",
          "pingpong"
        ],
        "default": "once",
        "description": "once, loop (jump back and go again) or pingpong (there and back forever)."
      },
      "on": {
        "type": "string",
        "default": "",
        "description": "Start when this event fires (a built-in one like \"checkpoint\", or a name a script emits). Empty = start with the scene."
      }
    }
  },
  "emitter": {
    "description": "Continuously emits visual particles from the entity (torches, sparkles, smoke). It does not affect gameplay.",
    "requires": [
      "transform"
    ],
    "fields": {
      "rate": {
        "type": "number",
        "min": 0,
        "default": 10,
        "description": "Particles per second."
      },
      "color": {
        "type": "string",
        "default": "#ffffff",
        "description": "Any CSS color."
      },
      "speed": {
        "type": "number",
        "min": 0,
        "default": 120,
        "description": "Launch speed in px/s."
      },
      "direction": {
        "type": "number",
        "default": -90,
        "description": "Launch angle in degrees. 0 = right, -90 = up, 90 = down."
      },
      "spread": {
        "type": "number",
        "min": 0,
        "default": 360,
        "description": "Random spread around direction, in degrees. 360 = all directions."
      },
      "life": {
        "type": "number",
        "min": 0,
        "default": 0.5,
        "description": "Seconds each particle lives; it shrinks and fades over that time."
      },
      "size": {
        "type": "number",
        "min": 0,
        "default": 3,
        "description": "Starting size in pixels."
      },
      "gravity": {
        "type": "number",
        "default": 400,
        "description": "Downward acceleration in px/s². Negative values float up."
      }
    }
  },
  "light": {
    "description": "3D: a light. directional = sunlight from the entity toward target, with crisp shadows; point = a bulb or torch shining all around; spot = a cone toward target; ambient = flat fill everywhere; hemisphere = sky color from above and groundColor from below (soft outdoor fill). Presentation only.",
    "requires": [
      "transform"
    ],
    "fields": {
      "type": {
        "type": "enum",
        "values": [
          "directional",
          "point",
          "spot",
          "ambient",
          "hemisphere"
        ],
        "default": "directional",
        "description": "What kind of light."
      },
      "color": {
        "type": "string",
        "default": "#ffffff",
        "description": "Light color."
      },
      "intensity": {
        "type": "number",
        "min": 0,
        "default": 1,
        "description": "Brightness. Sun 2-4, fill 0.3-1, torches 5-30 (point and spot fall off with distance)."
      },
      "groundColor": {
        "type": "string",
        "default": "#444444",
        "description": "hemisphere: the color from below."
      },
      "target": {
        "type": "object",
        "default": {
          "x": 0,
          "y": 0,
          "z": 0
        },
        "description": "directional and spot: the point it shines toward, { x, y, z } in metres."
      },
      "distance": {
        "type": "number",
        "min": 0,
        "default": 0,
        "description": "point and spot: how far it reaches, in metres. 0 = no limit."
      },
      "angle": {
        "type": "number",
        "min": 0,
        "default": 30,
        "description": "spot: half the cone's opening, in degrees."
      },
      "penumbra": {
        "type": "number",
        "min": 0,
        "default": 0.3,
        "description": "spot: how soft the cone's edge is, 0..1."
      },
      "castShadow": {
        "type": "boolean",
        "default": true,
        "description": "Throws shadows (directional, point and spot). Shadows cost time: a sun and a few key lights."
      },
      "shadowSize": {
        "type": "number",
        "min": 1,
        "default": 40,
        "description": "directional: the size in metres of the area its shadows cover, centred on the camera's target."
      }
    }
  }
};

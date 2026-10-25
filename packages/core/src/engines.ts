import { ArcadePhysics } from "./arcade.ts";
import type { PhysicsEngine } from "./physics.ts";

export const PHYSICS_ENGINES = ["arcade", "rapier"] as const;
export type PhysicsName = (typeof PHYSICS_ENGINES)[number];

/** What an engine needs to know about the world it will run. */
export interface PhysicsSettings {
  width: number;
  height: number;
  /** Downward acceleration in px/s². */
  gravity: number;
}

export type PhysicsFactory = (settings: PhysicsSettings) => PhysicsEngine;

/** A scene asked for an engine that hasn't been loaded. */
export class PhysicsUnavailableError extends Error {}

// Shared through globalThis, so an engine registered through one copy of this module
// (a package resolved twice, a dev server serving it at another URL) is still found.
const REGISTRY = Symbol.for("ludra.physics.engines");
const factories: Map<string, PhysicsFactory> = ((globalThis as Record<symbol, unknown>)[REGISTRY] ??= new Map<string, PhysicsFactory>()) as Map<
  string,
  PhysicsFactory
>;
factories.set("arcade", () => new ArcadePhysics());

/** Makes an engine available to scenes by name. @ludra/physics registers "rapier". */
export function registerPhysics(name: string, factory: PhysicsFactory): void {
  factories.set(name, factory);
}

export function isPhysicsLoaded(name: string): boolean {
  return factories.has(name);
}

export function createPhysics(name: string, settings: PhysicsSettings): PhysicsEngine {
  const factory = factories.get(name);
  if (!factory) {
    throw new PhysicsUnavailableError(
      name === "rapier"
        ? 'This scene uses "rapier" physics, which isn\'t loaded. Call await loadRapierPhysics() from @ludra/physics before creating the world (the ludra CLI and dev server do this for you).'
        : `Unknown physics engine "${name}". Use one of: ${PHYSICS_ENGINES.join(", ")}.`,
    );
  }
  return factory(settings);
}

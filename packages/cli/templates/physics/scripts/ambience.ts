import type { Script, SoundContext } from "@ludra/core";

/** Looping filtered noise whose loudness and color follow the game. */
interface Bed {
  filter: BiquadFilterNode;
  gain: GainNode;
}

interface Nodes {
  wind: Bed;
  swoosh: Bed;
  scrape: Bed;
}

/** Steady noise through a filter, silent until the hook turns it up. */
function bed(ctx: SoundContext, buffer: AudioBuffer, type: BiquadFilterType, frequency: number, q: number): Bed {
  const { audio, out } = ctx;
  const source = audio.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  const filter = audio.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = frequency;
  filter.Q.value = q;
  const gain = audio.createGain();
  gain.gain.value = 0;
  source.connect(filter).connect(gain).connect(out);
  source.start(0, ctx.random() * buffer.duration);
  return { filter, gain };
}

/**
 * The sound of the place, made with the Web Audio API and driven by the physics:
 * wind that grows as the player climbs, the spiked ball hissing through the air as
 * fast as it swings, the crate scraping while it slides, and planks creaking underfoot.
 */
export default {
  sound(ctx) {
    const { audio, world, local, time } = ctx;
    let nodes = local.nodes as Nodes | undefined;
    if (!nodes) {
      const buffer = audio.createBuffer(1, audio.sampleRate * 2, audio.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = ctx.random() * 2 - 1;
      nodes = {
        wind: bed(ctx, buffer, "bandpass", 400, 0.8),
        swoosh: bed(ctx, buffer, "bandpass", 600, 1.5),
        scrape: bed(ctx, buffer, "lowpass", 260, 4),
      };
      local.nodes = nodes;
    }
    const now = audio.currentTime;
    const player = world.player();

    // Wind: stronger and brighter the higher the player is, with a slow gust.
    const height = player ? Math.max(0, 1 - player.y / world.height) : 0;
    const gust = 0.5 + 0.5 * Math.sin(time * 0.6) * Math.sin(time * 0.23);
    nodes.wind.gain.gain.setTargetAtTime(0.027 + 0.11 * height * (0.6 + 0.4 * gust), now, 0.4);
    nodes.wind.filter.frequency.setTargetAtTime(280 + 600 * height + 200 * gust, now, 0.4);

    // The pendulum: a hiss that rises with its speed, loudest at the bottom of the swing.
    const ball = world.get("pendulum");
    const speed = ball ? Math.hypot(ball.vx, ball.vy) : 0;
    nodes.swoosh.gain.gain.setTargetAtTime(0.25 * Math.min(1, speed / 800) ** 2, now, 0.04);
    nodes.swoosh.filter.frequency.setTargetAtTime(300 + speed * 1.6, now, 0.04);

    // The crate grinds over the ground while it slides.
    const crate = world.get("crate");
    const sliding = crate?.grounded ? Math.min(1, Math.abs(crate.vx) / 90) : 0;
    nodes.scrape.gain.gain.setTargetAtTime(0.16 * sliding, now, 0.05);
    nodes.scrape.filter.frequency.setTargetAtTime(180 + 120 * sliding + 40 * Math.sin(time * 23), now, 0.02);

    // Planks creak under a walking player, never twice in a row the same.
    const walking = player?.grounded && Math.abs(player.vx) > 20;
    const onBridge = walking && world.all().some((e) => e.id.startsWith("plank-") && player.touches(e));
    const last = (local.lastCreak as number | undefined) ?? -Infinity;
    if (onBridge && time - last > 0.38 + ctx.random() * 0.25) {
      ctx.play("creak", { pitch: 0.8 + ctx.random() * 0.4, volume: 0.7 + ctx.random() * 0.5 });
      local.lastCreak = time;
    }
  },
} satisfies Script;

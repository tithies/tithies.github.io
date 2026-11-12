/**
 * The moving fire of the menu art (see MenuArt.tsx): embers drifting behind the figure, and in
 * front of it the fireball, the flames of the hair and of the lower hand, and sparks. Everything
 * is in the art's 600 × 800 view box; the canvases are scaled to it. Time is counted in 60 fps
 * frames (dt = 1 is one frame).
 */

const VIEW_WIDTH = 600;
const FIREBALL_X = 232;
const FIREBALL_Y = 104;
const HEAD_CENTER_X = 290;
const HEAD_CENTER_Y = 262;
const HEAD_ANGLE = (12 * Math.PI) / 180;
const HEAD_SCALE = 1.18;
/** Flame colours, from a new flame to a dying one. */
const PALETTE = ['#fff4cf', '#ffd86e', '#ffab3a', '#ff7a1f', '#f0441a', '#b71d1d', '#5c0d14'];
const LOWER_FINGERTIPS: [number, number][] = [
  [453, 394],
  [458, 405],
  [454, 418],
  [445, 426],
  [436, 388],
];

/** A flame (or a fireball orbiter): a glow that rises, shrinks and fades through PALETTE. */
interface Flame {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  size: number;
  alpha: number;
  drag: number;
  wind: number;
}

interface Orbit {
  angle: number;
  radius: number;
  spin: number;
  drift: number;
  rise: number;
  lift: number;
  age: number;
  life: number;
  size: number;
  alpha: number;
}

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  width: number;
}

interface Ember {
  x: number;
  y: number;
  vx: number;
  vy: number;
  phase: number;
  age: number;
  life: number;
  size: number;
}

export interface FireScene {
  /** Sizes the canvases for a stage of `width` × `height` CSS pixels, then draws. */
  resize(width: number, height: number, devicePixelRatio: number): void;
  /** Advances the fire by `dt` frames. */
  update(dt: number): void;
  render(): void;
  /** Flares the fireball and bursts sparks and flames out of it. */
  stoke(): void;
}

const random = (min: number, max: number) => min + Math.random() * (max - min);
const format = (value: number) => value.toFixed(1);

/** A row of spires, domes and towers standing on `baseY`, the same for the same seed. */
export function buildSkyline(seed: number, baseY: number, minHeight: number, maxHeight: number, minWidth: number, maxWidth: number): string {
  let state = seed;
  const next = () => {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  };
  const parts = [`M-10,${baseY} L610,${baseY} L610,${baseY + 90} L-10,${baseY + 90} Z`];
  let left = -6;
  while (left < 606) {
    const width = minWidth + next() * (maxWidth - minWidth);
    const height = minHeight + next() * (maxHeight - minHeight);
    const top = baseY - height;
    const right = left + width;
    const middle = left + width / 2;
    const roll = next();
    if (roll < 0.4) {
      parts.push(
        `M${format(left)},${baseY} L${format(left)},${format(top)} A${format(width / 2)},${format(width * 0.55)} 0 0 1 ${format(right)},${format(top)} L${format(right)},${baseY} Z`,
      );
      parts.push(`M${format(middle - 0.9)},${format(top - width * 0.5)} L${format(middle)},${format(top - width * 0.5 - 12)} L${format(middle + 0.9)},${format(top - width * 0.5)} Z`);
    } else if (roll < 0.75) {
      parts.push(`M${format(left)},${baseY} L${format(left)},${format(top)} L${format(middle)},${format(top - width * 2.4)} L${format(right)},${format(top)} L${format(right)},${baseY} Z`);
    } else {
      parts.push(`M${format(left)},${baseY} L${format(left)},${format(top)} L${format(right)},${format(top)} L${format(right)},${baseY} Z`);
      parts.push(`M${format(middle - 0.7)},${format(top)} L${format(middle)},${format(top - 18)} L${format(middle + 0.7)},${format(top)} Z`);
    }
    left = right + next() * width * 0.8;
  }
  return parts.join(' ');
}

const toRgba = (hex: string, alpha: number) => {
  const value = parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
};

/** A soft round glow of `color`, drawn scaled for every flame. */
const makeSprite = (color: string) => {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext('2d')!;
  const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, toRgba(color, 1));
  gradient.addColorStop(0.4, toRgba(color, 0.55));
  gradient.addColorStop(1, toRgba(color, 0));
  context.fillStyle = gradient;
  context.fillRect(0, 0, 64, 64);
  return canvas;
};

/** A point of the head's own drawing, placed where the tilted, enlarged head draws it. */
const fromHead = ([x, y]: [number, number]) => {
  const offsetX = (x - HEAD_CENTER_X) * HEAD_SCALE;
  const offsetY = (y - HEAD_CENTER_Y) * HEAD_SCALE;
  return {
    x: HEAD_CENTER_X + offsetX * Math.cos(HEAD_ANGLE) - offsetY * Math.sin(HEAD_ANGLE),
    y: HEAD_CENTER_Y + offsetX * Math.sin(HEAD_ANGLE) + offsetY * Math.cos(HEAD_ANGLE),
  };
};

const HAIR_ROOTS = (
  [
    [284, 234],
    [296, 229],
    [308, 233],
    [316, 244],
    [319, 258],
    [316, 272],
    [310, 286],
  ] as [number, number][]
).map(fromHead);
const HAIR_TIPS = (
  [
    [312, 160],
    [332, 204],
    [384, 178],
    [362, 214],
    [404, 218],
  ] as [number, number][]
).map(fromHead);

/** How many particles to spawn this step for `rate` per frame, carrying fractions by chance. */
const spawnCount = (rate: number, dt: number) => {
  const exact = rate * dt;
  return Math.floor(exact) + (Math.random() < exact % 1 ? 1 : 0);
};

const pick = <T>(items: T[]) => items[Math.floor(Math.random() * items.length)];

const resetEmber = (ember: Ember, isAnywhere: boolean): Ember => {
  ember.x = random(-20, 600);
  ember.y = isAnywhere ? random(120, 800) : random(760, 820);
  ember.vx = random(0.15, 0.6);
  ember.vy = random(-1, -0.3);
  ember.phase = random(0, Math.PI * 2);
  ember.age = isAnywhere ? random(0, 300) : 0;
  ember.life = random(320, 620);
  ember.size = random(1.6, 4.2);
  return ember;
};

const pointOnHairRoots = () => {
  const index = Math.floor(Math.random() * (HAIR_ROOTS.length - 1));
  const start = HAIR_ROOTS[index];
  const end = HAIR_ROOTS[index + 1];
  const along = Math.random();
  return {
    x: start.x + (end.x - start.x) * along + random(-4, 4),
    y: start.y + (end.y - start.y) * along + random(-4, 4),
  };
};

/** Draws on `back` (behind the figure) and `front` (over it). */
export function createFireScene(back: HTMLCanvasElement, front: HTMLCanvasElement): FireScene {
  const backContext = back.getContext('2d')!;
  const frontContext = front.getContext('2d')!;
  const sprites = PALETTE.map(makeSprite);

  let flames: Flame[] = [];
  let orbits: Orbit[] = [];
  let sparks: Spark[] = [];
  const embers = Array.from({ length: 80 }, () => resetEmber({} as Ember, true));
  /** The fireball's size factor: 1 at rest, raised by stoke() and easing back. */
  let flare = 1;
  let clock = 0;
  let pixelScale = 1;

  const addFlame = (x: number, y: number, options: Pick<Flame, 'vx' | 'vy' | 'life' | 'size' | 'alpha'> & Partial<Flame>) => {
    flames.push({ x, y, age: 0, drag: 0.995, wind: 0, ...options });
  };

  const addSpark = (x: number, y: number, vx: number, vy: number) => {
    sparks.push({ x, y, vx, vy, age: 0, life: random(40, 85), width: random(0.8, 1.8) });
  };

  const emit = (dt: number) => {
    // The burning hair: along its roots, and shorter tongues at its tips.
    for (let count = spawnCount(7, dt); count > 0; count--) {
      const root = pointOnHairRoots();
      addFlame(root.x, root.y, { vx: random(0.4, 1.3), vy: random(-2.6, -1.3), wind: 0.025, life: random(34, 60), size: random(9, 19), alpha: 0.5 });
    }
    for (let count = spawnCount(2, dt); count > 0; count--) {
      const tip = pick(HAIR_TIPS);
      addFlame(tip.x + random(-5, 5), tip.y + random(-5, 5), { vx: random(0.6, 1.4), vy: random(-2, -0.9), wind: 0.02, life: random(16, 30), size: random(5, 10), alpha: 0.5 });
    }
    // The raised hand, under the fireball.
    for (let count = spawnCount(3, dt); count > 0; count--) {
      addFlame(random(224, 248), random(152, 172), { vx: random(-0.3, 0.3), vy: random(-2.2, -1.2), life: random(12, 22), size: random(5, 9), alpha: 0.6 });
    }
    // The fingertips of the lower hand.
    for (let count = spawnCount(5, dt); count > 0; count--) {
      const [tipX, tipY] = pick(LOWER_FINGERTIPS);
      addFlame(tipX + random(-3, 3), tipY + random(-3, 3), { vx: random(0.5, 1.6), vy: random(-1.7, -0.5), wind: 0.02, life: random(18, 36), size: random(6, 13), alpha: 0.6 });
    }
    // The fireball: flames whirling around its core.
    for (let count = spawnCount(9 * flare, dt); count > 0; count--) {
      orbits.push({
        angle: random(0, Math.PI * 2),
        radius: random(6, 42) * flare,
        spin: random(0.05, 0.11),
        drift: random(-0.05, 0.35),
        rise: random(0.15, 0.45),
        lift: 0,
        age: 0,
        life: random(20, 40),
        size: random(12, 24) * flare,
        alpha: 0.55,
      });
    }
    // Sparks thrown off the fireball and the hair.
    for (let count = spawnCount(0.7, dt); count > 0; count--) {
      const angle = random(0, Math.PI * 2);
      const speed = random(0.8, 3.2);
      addSpark(FIREBALL_X + Math.cos(angle) * random(10, 40), FIREBALL_Y + Math.sin(angle) * random(10, 40), Math.cos(angle) * speed + 0.3, Math.sin(angle) * speed - 1.2);
    }
    for (let count = spawnCount(0.25, dt); count > 0; count--) {
      const root = pointOnHairRoots();
      addSpark(root.x, root.y, random(0.6, 1.8), random(-2.6, -1.2));
    }
  };

  const update = (dt: number) => {
    clock += dt;
    flare += (1 - flare) * Math.min(1, 0.05 * dt);
    emit(dt);

    for (const flame of flames) {
      flame.age += dt;
      flame.vx = (flame.vx + flame.wind * dt) * Math.pow(flame.drag, dt);
      flame.vy *= Math.pow(flame.drag, dt);
      flame.x += flame.vx * dt;
      flame.y += flame.vy * dt;
    }
    flames = flames.filter((flame) => flame.age < flame.life);

    for (const orbit of orbits) {
      orbit.age += dt;
      orbit.angle += orbit.spin * dt;
      orbit.radius += orbit.drift * dt;
      orbit.lift += orbit.rise * dt;
    }
    orbits = orbits.filter((orbit) => orbit.age < orbit.life);

    for (const spark of sparks) {
      spark.age += dt;
      spark.vy += 0.025 * dt;
      spark.vx *= Math.pow(0.995, dt);
      spark.x += spark.vx * dt;
      spark.y += spark.vy * dt;
    }
    sparks = sparks.filter((spark) => spark.age < spark.life);

    for (const ember of embers) {
      ember.age += dt;
      ember.x += (ember.vx + Math.sin(ember.age * 0.035 + ember.phase) * 0.3) * dt;
      ember.y += ember.vy * dt;
      if (ember.age > ember.life || ember.y < -10 || ember.x > 620) resetEmber(ember, false);
    }
  };

  const drawSprite = (context: CanvasRenderingContext2D, x: number, y: number, particle: Flame | Orbit) => {
    const progress = particle.age / particle.life;
    const sprite = sprites[Math.min(sprites.length - 1, Math.floor(progress * sprites.length))];
    const size = particle.size * (1 - 0.65 * progress);
    context.globalAlpha = particle.alpha * (1 - progress);
    context.drawImage(sprite, x - size, y - size, size * 2, size * 2);
  };

  const prepare = (canvas: HTMLCanvasElement, context: CanvasRenderingContext2D) => {
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = 1;
    context.globalCompositeOperation = 'source-over';
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.setTransform(pixelScale, 0, 0, pixelScale, 0, 0);
    context.globalCompositeOperation = 'lighter';
  };

  const drawBack = () => {
    prepare(back, backContext);
    for (const ember of embers) {
      const progress = ember.age / ember.life;
      const sprite = ember.size > 3 ? sprites[1] : sprites[3];
      const radius = ember.size * 2;
      backContext.globalAlpha = Math.sin(progress * Math.PI) * 0.9;
      backContext.drawImage(sprite, ember.x - radius, ember.y - radius, radius * 2, radius * 2);
    }
  };

  const drawFront = () => {
    prepare(front, frontContext);
    const pulse = (1 + Math.sin(clock * 0.12) * 0.04 + Math.sin(clock * 0.37) * 0.02) * flare;
    const radius = 44 * pulse;

    const halo = frontContext.createRadialGradient(FIREBALL_X, FIREBALL_Y, 0, FIREBALL_X, FIREBALL_Y, radius * 2.4);
    halo.addColorStop(0, 'rgba(255, 236, 190, 0.9)');
    halo.addColorStop(0.22, 'rgba(255, 170, 60, 0.55)');
    halo.addColorStop(0.5, 'rgba(255, 80, 20, 0.18)');
    halo.addColorStop(1, 'rgba(160, 20, 20, 0)');
    frontContext.globalAlpha = 1;
    frontContext.fillStyle = halo;
    frontContext.beginPath();
    frontContext.arc(FIREBALL_X, FIREBALL_Y, radius * 2.4, 0, Math.PI * 2);
    frontContext.fill();

    for (const orbit of orbits) {
      drawSprite(frontContext, FIREBALL_X + Math.cos(orbit.angle) * orbit.radius, FIREBALL_Y + Math.sin(orbit.angle) * orbit.radius * 0.85 - orbit.lift, orbit);
    }
    for (const flame of flames) drawSprite(frontContext, flame.x, flame.y, flame);

    frontContext.lineCap = 'round';
    for (const spark of sparks) {
      const progress = spark.age / spark.life;
      frontContext.globalAlpha = 1 - progress;
      frontContext.strokeStyle = progress < 0.4 ? '#fff1b8' : progress < 0.75 ? '#ffb347' : '#ff5a1f';
      frontContext.lineWidth = spark.width;
      frontContext.beginPath();
      frontContext.moveTo(spark.x, spark.y);
      frontContext.lineTo(spark.x - spark.vx * 2.5, spark.y - spark.vy * 2.5);
      frontContext.stroke();
    }

    const core = frontContext.createRadialGradient(FIREBALL_X, FIREBALL_Y, 0, FIREBALL_X, FIREBALL_Y, radius * 0.6);
    core.addColorStop(0, 'rgba(255, 255, 245, 0.95)');
    core.addColorStop(1, 'rgba(255, 220, 140, 0)');
    frontContext.globalAlpha = 1;
    frontContext.fillStyle = core;
    frontContext.beginPath();
    frontContext.arc(FIREBALL_X, FIREBALL_Y, radius * 0.6, 0, Math.PI * 2);
    frontContext.fill();
  };

  const render = () => {
    drawBack();
    drawFront();
  };

  // Start with the fire already burning, not lighting up.
  for (let frame = 0; frame < 140; frame++) update(1);

  return {
    resize(width, height, devicePixelRatio) {
      const ratio = Math.min(devicePixelRatio || 1, 2);
      for (const canvas of [back, front]) {
        canvas.width = Math.max(1, Math.round(width * ratio));
        canvas.height = Math.max(1, Math.round(height * ratio));
      }
      pixelScale = (width * ratio) / VIEW_WIDTH;
      render();
    },
    update,
    render,
    stoke() {
      flare = 1.75;
      for (let count = 0; count < 160; count++) {
        const angle = random(0, Math.PI * 2);
        const speed = random(2, 7);
        addSpark(FIREBALL_X, FIREBALL_Y, Math.cos(angle) * speed, Math.sin(angle) * speed - 0.8);
      }
      for (let count = 0; count < 50; count++) {
        const angle = random(0, Math.PI * 2);
        const speed = random(1.5, 4.5);
        addFlame(FIREBALL_X + Math.cos(angle) * 20, FIREBALL_Y + Math.sin(angle) * 20, {
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed - 0.6,
          drag: 0.94,
          life: random(20, 36),
          size: random(14, 26),
          alpha: 0.55,
        });
      }
    },
  };
}
